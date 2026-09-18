import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createGovernedServer } from '../dist/rpc/server.js';
import { GovernanceClient } from '../dist/rpc/client.js';
import { BatchRunner } from '../dist/surface/ci.js';
import { MockAPIServer, doneResponse, auditPassResponse } from './mock-server.js';
import { createInProcessTestContext, InProcessTestContext, getTestPort } from './utils.js';

const TEST_PORT = getTestPort(13); // surface-ci.test.ts uses port 18778

function happyClient(base: string): { server: MockAPIServer; client: GovernanceClient } {
  // A successful run consumes 2 calls per prompt: odd=DONE, even=audit-pass.
  const server = new MockAPIServer(() => doneResponse('done'));
  return { server, client: new GovernanceClient(base) };
}

describe('BatchRunner (Phase 4b)', () => {
  let server: MockAPIServer;
  let ctx: InProcessTestContext;
  let httpServer: any;
  let base: string;
  let client: GovernanceClient;

  before(async () => {
    server = new MockAPIServer(() => doneResponse('done'));
    server.port = TEST_PORT;
    await server.start();
    httpServer = createGovernedServer();
    const addr: any = await new Promise((resolve) => httpServer.listen(0, () => resolve(httpServer.address())));
    base = `http://localhost:${addr.port}`;
    client = new GovernanceClient(base);
  });

  after(async () => {
    await server.stop();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  beforeEach(() => {
    ctx = createInProcessTestContext(TEST_PORT);
    server.reset();
    // Each successful run consumes exactly 2 mock calls: one DONE for the main
    // loop, one audit-pass for the audit step. The generator keys on the message
    // content (not requestNum parity) so it stays correct under the shared
    // counter that concurrent runs share.
    server.setGenerator((messages) => {
      const last = messages[messages.length - 1];
      if (last && last.content === 'Begin the audit.') return auditPassResponse();
      if (messages.some((m) => (m.content || '').trim() === 'bad')) {
        // The "bad" prompt never reaches DONE: it repeatedly issues a READ_FILE
        // for a missing file, so the run exhausts maxLoops (a failure) instead
        // of succeeding. This keeps the batch deterministic under concurrency.
        return { thoughts: 'inspect', taskList: ['[~] inspect'], toolChoice: 'READ_FILE', toolInput: '/no/such/file.xyz' };
      }
      return doneResponse('done');
    });
  });

  afterEach(() => {
    ctx.cleanup();
    ctx.restoreEnv();
  });

  const runCfg = (over: Record<string, unknown> = {}) => ({
    apiUrl: `http://localhost:${TEST_PORT}/v1`,
    model: 'test-model',
    maxLoops: 20,
    maxRetriesAutomated: 3,
    ...over,
  });

  it('runs a batch sequentially and reports all succeeded', async () => {
    const report = await new BatchRunner(client).run([
      { label: 'a', prompt: 'do a', cwd: ctx.tempDir, config: runCfg(), actor: { id: 'u1', scopes: ['read', 'write'] } },
      { label: 'b', prompt: 'do b', cwd: ctx.tempDir, config: runCfg(), actor: { id: 'u1', scopes: ['read', 'write'] } },
      { label: 'c', prompt: 'do c', cwd: ctx.tempDir, config: runCfg(), actor: { id: 'u1', scopes: ['read', 'write'] } },
    ]);

    assert.strictEqual(report.total, 3);
    assert.strictEqual(report.succeeded, 3);
    assert.strictEqual(report.failed, 0);
    for (const s of report.steps) {
      assert.ok(s.outcome, `step ${s.label} should have an outcome`);
      assert.strictEqual(s.outcome?.type, 'done');
    }
    assert.strictEqual(BatchRunner.summary(report), '3/3 succeeded, 0 failed');
  });

  it('collects per-step callbacks', async () => {
    const seen: string[] = [];
    await new BatchRunner(client).run([
      { prompt: 'p1', cwd: ctx.tempDir, config: runCfg(), actor: { id: 'u1' } },
      { prompt: 'p2', cwd: ctx.tempDir, config: runCfg(), actor: { id: 'u1' } },
    ], (s) => seen.push(s.label));

    assert.deepStrictEqual(seen, ['prompt-1', 'prompt-2']);
  });

  it('isolates a failing prompt without aborting the batch', async () => {
    // Prompt 1 succeeds against the mock. Prompt 2 ("bad") never reaches DONE -
    // it issues READ_FILE for a missing file on every iteration and so exhausts
    // maxLoops (a failure). A failing step never aborts the rest of the batch.
    const report = await new BatchRunner(client).run([
      { label: 'ok', prompt: 'ok', cwd: ctx.tempDir, config: runCfg(), actor: { id: 'u1', scopes: ['read', 'write'] } },
      { label: 'bad', prompt: 'bad', cwd: ctx.tempDir, config: runCfg({ apiUrl: 'http://127.0.0.1:1/v1', maxRetriesAutomated: 1, maxApiRetries: 1, requestTimeout: 1 }), actor: { id: 'u1' } },
    ]);

    assert.strictEqual(report.total, 2);
    assert.strictEqual(report.succeeded, 1);
    assert.strictEqual(report.failed, 1);
    assert.strictEqual(report.steps[0].outcome?.type, 'done');
    assert.ok(report.steps[1].outcome && report.steps[1].outcome.type !== 'done', 'the failed step should not have succeeded');
  });

  it('runs with bounded concurrency', async () => {
    const report = await new BatchRunner(client, { concurrency: 2 }).run([
      { prompt: 'x1', cwd: ctx.tempDir, config: runCfg(), actor: { id: 'u1', scopes: ['read', 'write'] } },
      { prompt: 'x2', cwd: ctx.tempDir, config: runCfg(), actor: { id: 'u1', scopes: ['read', 'write'] } },
    ]);
    assert.strictEqual(report.total, 2);
    assert.strictEqual(report.succeeded, 2);
  });
});
