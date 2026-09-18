// Flagship e2e against a REAL governed HTTP server + the REAL BrowserAgentClient
// (the browser-friendly, Node-free surface) + REAL LLM. Mirrors tests/e2e
// conventions: imports from compiled ../dist, fixtures from ./server-utils and
// ../utils, generous per-test timeouts for anything triggering a real LLM run.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RpcEvent } from '../../dist/rpc/protocol.js';
import { BrowserAgentClient } from '../../dist/surface/browser.js';
import {
  makeTempCwd,
  realLlmConfig,
  startGovernedServer,
  writeFileInput,
} from './server-utils.js';

const FAST_TIMEOUT_MS = 60000;

describe('E2E: BrowserAgentClient (real governed server + real LLM)', () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  let client: BrowserAgentClient;

  beforeEach(async () => {
    server = await startGovernedServer();
    client = new BrowserAgentClient(server.baseUrl);
  });

  afterEach(async () => {
    await server.close();
  });

  it('list_tools returns the governed catalog with metadata', { timeout: FAST_TIMEOUT_MS }, async () => {
    const tools = await client.listTools();
    assert.ok(tools.length > 0, 'the catalog should be non-empty');

    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['WRITE_FILE', 'READ_FILE', 'COMMAND', 'DONE']) {
      assert.ok(byName.has(name), `expected catalog to include ${name}`);
      const t = byName.get(name)!;
      assert.strictEqual(typeof t.label, 'string', `${name} label should be a string`);
      assert.strictEqual(typeof t.description, 'string', `${name} description should be a string`);
      assert.ok(Array.isArray(t.capabilities), `${name} capabilities should be an array`);
      assert.strictEqual(typeof t.mutates, 'boolean', `${name} mutates should be a boolean`);
    }
  });

  it('drives a real end-to-end run over the wire, collecting events via on/off', { timeout: 240000 }, async () => {
    const cwd = makeTempCwd();

    // Subscribe to the lifecycle events and collect them separately from the
    // returned events array, so we can assert both paths received them.
    const started: RpcEvent[] = [];
    const tools: RpcEvent[] = [];
    const finished: RpcEvent[] = [];
    client.on('start', (e) => started.push(e));
    client.on('tool', (e) => tools.push(e));
    client.on('done', (e) => finished.push(e));

    const { events, result } = await client.run({
      prompt: 'Create a file named bg.txt containing exactly the text browser-e2e-ok and report success.',
      cwd,
      actor: { id: 'e2e-browser' },
      config: realLlmConfig(),
    });

    // The returned events array must carry the streamed lifecycle events.
    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes('start'), 'returned events should include a start event');
    assert.ok(eventNames.includes('tool'), 'returned events should include at least one tool event');
    assert.ok(eventNames.includes('done'), 'returned events should include a done event');

    // The subscribed callbacks must receive the same set of events.
    assert.ok(started.length >= 1, 'the start subscriber should fire at least once');
    assert.ok(tools.length >= 1, 'the tool subscriber should fire at least once');
    assert.ok(finished.length >= 1, 'the done subscriber should fire at least once');

    assert.strictEqual(result.type, 'done', `run should complete as done, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.auditPassed, true, 'the audit pass flag should be true');

    // Ground truth: the real model actually wrote the file to disk.
    const bg = join(cwd, 'bg.txt');
    assert.ok(existsSync(bg), 'bg.txt should exist on disk');
    assert.ok(
      readFileSync(bg, 'utf-8').includes('browser-e2e-ok'),
      `bg.txt should contain the requested marker, got: ${readFileSync(bg, 'utf-8')}`
    );
  });

  it('on/off actually manages subscriptions (unsubscribed token callback never fires)', { timeout: 360000 }, async () => {
    const cwd = makeTempCwd();

    // First: prove the token callback DOES fire while subscribed, so a zero count
    // after unsubscribe is meaningful and not just a no-token run.
    let tokenCount = 0;
    const onToken = (): void => { tokenCount++; };
    client.on('token', onToken);

    await client.run({
      prompt: 'reply with the single word ok',
      cwd,
      actor: { id: 'e2e-sub1' },
      config: realLlmConfig(),
    });
    assert.ok(tokenCount >= 1, 'the subscribed token callback should have fired at least once');

    // Now unsubscribe and run again: other events still reach subscribers, but the
    // previously-registered token callback must NOT fire for this run.
    const otherEvents: string[] = [];
    client.off('token', onToken);
    client.on('start', () => otherEvents.push('start'));
    client.on('done', () => otherEvents.push('done'));

    const before = tokenCount;
    await client.run({
      prompt: 'reply with the single word ok',
      cwd,
      actor: { id: 'e2e-sub2' },
      config: realLlmConfig(),
    });

    assert.strictEqual(tokenCount, before, 'the unsubscribed token callback must not fire after off()');
    assert.ok(otherEvents.includes('start'), 'other subscribers still receive start');
    assert.ok(otherEvents.includes('done'), 'other subscribers still receive done');
  });

  it('executes a governed single tool call (WRITE_FILE) over the wire and reads it back', { timeout: FAST_TIMEOUT_MS }, async () => {
    const cwd = makeTempCwd();
    const bPath = `${cwd}/b.txt`;
    const { result } = await client.tool({
      runId: 'e2e-browser-tool',
      toolName: 'WRITE_FILE',
      input: writeFileInput(bPath, 'browser'),
      cwd,
      actor: { id: 'e2e-browser-tool' },
    });

    assert.strictEqual(result.errored, false, `WRITE_FILE should not error: ${JSON.stringify(result)}`);
    assert.ok(existsSync(bPath), 'b.txt should exist on disk');
    assert.strictEqual(readFileSync(bPath, 'utf-8'), 'browser', 'b.txt should contain "browser"');

    // READ the file back through the governed tool surface.
    const { result: read } = await client.tool({
      runId: 'e2e-browser-tool-read',
      toolName: 'READ_FILE',
      input: `"${bPath}"`,
      cwd,
      actor: { id: 'e2e-browser-tool' },
    });
    assert.strictEqual(read.errored, false, `READ_FILE should not error: ${JSON.stringify(read)}`);
    assert.strictEqual(read.outcome, 'browser', `READ_FILE should report "browser", got: ${read.outcome}`);
  });

  it('status() is an array, empties after a completed run, and stop() reports false on a non-active run', { timeout: 240000 }, async () => {
    // status() must return an array and start empty.
    const initial = await client.status();
    assert.ok(Array.isArray(initial), 'status() should return an array');

    // Fast, non-LLM part of the lifecycle checks: stop() on a run that is never
    // active must report false.
    const stopped = await client.stop('e2e-browser-never-active');
    assert.strictEqual(stopped, false, 'stop() on a non-active run id should return false');

    // A completed real run leaves the active-sets empty again.
    const cwd = makeTempCwd();
    const { result } = await client.run({
      prompt: 'reply with the single word ok',
      cwd,
      actor: { id: 'e2e-browser-status' },
      config: realLlmConfig(),
    });
    assert.strictEqual(result.type, 'done', 'the run should complete');

    const after = await client.status();
    assert.ok(Array.isArray(after), 'status() should return an array');
    assert.deepStrictEqual(after, [], 'status should be empty again after the run finished');
  });
});
