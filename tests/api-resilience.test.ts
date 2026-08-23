import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createServer, Server } from 'http';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { streamCompletion, isContextOverflowError } from '../dist/agent/api.js';
import { configExists, loadConfig } from '../dist/config/index.js';
import { isSpinnerActive } from '../dist/ui/spinner.js';
import { createInProcessTestContext, getTestPort, InProcessTestContext } from './utils.js';

const TEST_PORT = getTestPort(74); // dedicated port range for this file

describe('API resilience', () => {
  let ctx: InProcessTestContext | null = null;
  let server: Server | null = null;

  const listen = (handler: Parameters<typeof createServer>[1]): Promise<void> =>
    new Promise(resolve => { server = createServer(handler); server.listen(TEST_PORT, () => resolve()); });

  afterEach(async () => {
    if (server) { await new Promise<void>(r => server!.close(() => r())); server = null; }
    ctx?.restoreEnv(); ctx?.cleanup(); ctx = null;
  });

  describe('first-time setup bootstrap', () => {
    it('loadConfig does not create the config file', () => {
      // Regression: loadConfig used to write DEFAULTS, which made configExists()
      // true on the first incidental read. First-time setup then never ran and
      // the user was silently left pointed at the default localhost endpoint.
      ctx = createInProcessTestContext(TEST_PORT);
      const path = join(ctx.configDir, 'config.json');
      // createInProcessTestContext writes one; remove it to simulate a fresh install.
      rmSync(path, { force: true });

      assert.equal(configExists(), false);
      loadConfig();
      loadConfig();
      assert.equal(configExists(), false, 'setup must still be pending after reads');
      assert.equal(existsSync(path), false);
    });

    it('still returns usable defaults when nothing is configured', () => {
      ctx = createInProcessTestContext(TEST_PORT);
      rmSync(join(ctx.configDir, 'config.json'), { force: true });

      const config = loadConfig();
      assert.ok(config.apiUrl, 'defaults should still be returned');
      assert.ok(config.maxTokens > 0);
    });
  });

  describe('spinner is never left running', () => {
    it('clears the spinner when the endpoint is unreachable', async () => {
      // Port deliberately not listening.
      ctx = createInProcessTestContext(TEST_PORT, {
        requestTimeout: 2, maxApiRetries: 2, apiRetryWindow: 10,
      });

      await assert.rejects(() => streamCompletion([{ role: 'user', content: 'hi' }], { silent: false }));
      assert.equal(isSpinnerActive(), false, 'a thrown fetch must not leave "Thinking..." on screen');
    });
  });

  describe('retry and backoff', () => {
    it('retries a 500 and succeeds when the server recovers', async () => {
      let hits = 0;
      await listen((_req, res) => {
        hits++;
        if (hits < 3) { res.writeHead(500); res.end('boom'); return; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'recovered' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
      ctx = createInProcessTestContext(TEST_PORT, {
        requestTimeout: 5, maxApiRetries: 5, apiRetryWindow: 60,
      });

      const out = await streamCompletion([{ role: 'user', content: 'hi' }], { silent: true });
      assert.equal(out, 'recovered');
      assert.equal(hits, 3, 'should have retried twice before succeeding');
    });

    it('gives up after the configured attempts and names the endpoint', async () => {
      let hits = 0;
      await listen((_req, res) => { hits++; res.writeHead(503); res.end('nope'); });
      ctx = createInProcessTestContext(TEST_PORT, {
        requestTimeout: 5, maxApiRetries: 3, apiRetryWindow: 60,
      });

      await assert.rejects(
        () => streamCompletion([{ role: 'user', content: 'hi' }], { silent: true }),
        (e: Error) => {
          assert.match(e.message, /failed after 3 attempt\(s\)/);
          assert.match(e.message, /dev setup/, 'error should tell the user how to fix it');
          return true;
        }
      );
      assert.equal(hits, 3);
    });

    it('does NOT retry a 400 - it is a real rejection, not a blip', async () => {
      let hits = 0;
      await listen((_req, res) => {
        hits++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: "This model's maximum context length is 131072 tokens." } }));
      });
      ctx = createInProcessTestContext(TEST_PORT, {
        requestTimeout: 5, maxApiRetries: 10, apiRetryWindow: 60,
      });

      const err = await streamCompletion([{ role: 'user', content: 'hi' }], { silent: true })
        .then(() => null, (e: Error) => e);

      assert.ok(err, 'should have thrown');
      assert.equal(hits, 1, 'a 400 must fail fast, not burn 10 retries');
      assert.equal(isContextOverflowError(err!), true, 'overflow handler must still recognise it');
    });

    it('does not retry an auth failure', async () => {
      let hits = 0;
      await listen((_req, res) => { hits++; res.writeHead(401); res.end('unauthorized'); });
      ctx = createInProcessTestContext(TEST_PORT, {
        requestTimeout: 5, maxApiRetries: 10, apiRetryWindow: 60,
      });

      await assert.rejects(() => streamCompletion([{ role: 'user', content: 'hi' }], { silent: true }));
      assert.equal(hits, 1);
    });

    it('does NOT abort a slow but healthy stream', async () => {
      // Regression: a total-duration timeout would kill a long generation
      // mid-flight, and because tokens had already been emitted it could not be
      // retried either - the whole response was lost. The watchdog must only
      // fire on a genuine stall, so a stream that keeps trickling survives well
      // past the per-attempt timeout.
      await listen((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        let n = 0;
        const tick = setInterval(() => {
          if (n < 6) {
            res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'x' } }] })}\n\n`);
            n++;
          } else {
            clearInterval(tick);
            res.write('data: [DONE]\n\n');
            res.end();
          }
        }, 400); // 6 chunks over ~2.4s, each gap under the 1s stall timeout
      });
      ctx = createInProcessTestContext(TEST_PORT, {
        requestTimeout: 1, maxApiRetries: 2, apiRetryWindow: 30,
      });

      const out = await streamCompletion([{ role: 'user', content: 'hi' }], { silent: true });
      assert.equal(out, 'xxxxxx', 'every chunk should arrive despite total time exceeding the timeout');
    });

    it('times out a server that accepts but never responds', async () => {
      await listen(() => { /* never replies */ });
      ctx = createInProcessTestContext(TEST_PORT, {
        requestTimeout: 1, maxApiRetries: 2, apiRetryWindow: 30,
      });

      const started = Date.now();
      await assert.rejects(() => streamCompletion([{ role: 'user', content: 'hi' }], { silent: true }));
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 20000, `must be bounded, took ${elapsed}ms`);
    });
  });
});
