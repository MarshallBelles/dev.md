// Flagship e2e against a REAL governed HTTP server + REAL client + REAL LLM.
// Mirrors tests/e2e conventions: imports from compiled ../dist, fixtures from
// ../utils, generous per-test timeouts for anything triggering a real LLM run.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request, serialize, parse, isResult, type RpcMessage } from '../../dist/rpc/protocol.js';
import { GovernanceClient } from '../../dist/rpc/client.js';
import {
  clientRun,
  clientTool,
  realLlmConfig,
  makeTempCwd,
  startGovernedServer,
  writeFileInput,
} from './server-utils.js';
import { sleep } from '../utils.js';

const RAW_TIMEOUT_MS = 15000;

// Parse the newline-delimited response body into its constituent messages.
const readRawMessages = async (res: Response): Promise<RpcMessage[]> => {
  const text = await res.text();
  return text.split('\n').filter(Boolean).map((l) => parse(l));
};

describe('E2E: Governed RPC microservice (real server + real LLM)', () => {
  let server: { baseUrl: string; close: () => Promise<void> };
  let client: GovernanceClient;

  beforeEach(async () => {
    server = await startGovernedServer();
    client = new GovernanceClient(server.baseUrl);
  });

  afterEach(async () => {
    await server.close();
  });

  it('list_tools returns the governed tool catalog with metadata', { timeout: 60000 }, async () => {
    const tools = await client.listTools();
    assert.ok(tools.length > 0, 'the catalog should be non-empty');
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ['WRITE_FILE', 'READ_FILE', 'LIST_DIRECTORY', 'COMMAND']) {
      assert.ok(byName.has(name), `expected catalog to include ${name}`);
      const t = byName.get(name)!;
      assert.strictEqual(typeof t.label, 'string', `${name} label should be a string`);
      assert.strictEqual(typeof t.description, 'string', `${name} description should be a string`);
      assert.ok(Array.isArray(t.capabilities), `${name} capabilities should be an array`);
      assert.strictEqual(typeof t.mutates, 'boolean', `${name} mutates should be a boolean`);
    }
  });

  it('runs a real end-to-end prompt over HTTP, writing and reading a file', { timeout: 240000 }, async () => {
    const cwd = makeTempCwd();
    const { events, result } = await clientRun(
      client,
      'Create a file named greeting.txt containing exactly the text hello-from-rpc-e2e and then read it back and report success.',
      cwd,
      { id: 'e2e-run' },
      realLlmConfig(),
    );

    assert.strictEqual(result.type, 'done', `run should complete as done, got: ${JSON.stringify(result)}`);
    assert.strictEqual(result.auditPassed, true, 'audit should have passed');

    const eventNames = events.map((e) => e.event);
    assert.ok(eventNames.includes('tool'), 'should have streamed at least one tool event');
    assert.ok(eventNames.includes('done'), 'should have streamed a done event');
    assert.ok(eventNames.includes('start'), 'should have streamed a start event');

    // Ground truth: the model actually wrote the file to disk.
    const greeting = join(cwd, 'greeting.txt');
    assert.ok(existsSync(greeting), 'greeting.txt should exist on disk');
    assert.ok(
      readFileSync(greeting, 'utf-8').includes('hello-from-rpc-e2e'),
      `greeting.txt should contain the requested text, got: ${readFileSync(greeting, 'utf-8')}`
    );
  });

  it('executes a governed single tool call (WRITE_FILE) over the wire and reads it back', { timeout: 60000 }, async () => {
    const cwd = makeTempCwd();
    const helloPath = `${cwd}/hello.txt`;
    const result = await clientTool(client, 'WRITE_FILE', writeFileInput(helloPath, 'hi'), cwd);

    assert.strictEqual(result.errored, false, `WRITE_FILE should not error: ${JSON.stringify(result)}`);

    assert.ok(existsSync(helloPath), 'hello.txt should exist on disk');
    assert.strictEqual(readFileSync(helloPath, 'utf-8'), 'hi', 'hello.txt should contain "hi"');

    // READ the file back through the governed tool surface.
    const readResult = await clientTool(client, 'READ_FILE', `"${helloPath}"`, cwd);
    assert.strictEqual(readResult.errored, false, `READ_FILE should not error: ${JSON.stringify(readResult)}`);
    assert.strictEqual(readResult.outcome, 'hi', `READ_FILE should report "hi", got: ${readResult.outcome}`);
  });

  it('status() is empty before and after a completed run', { timeout: 180000 }, async () => {
    assert.deepStrictEqual(await client.status(), [], 'status should start empty');

    const cwd = makeTempCwd();
    const { result } = await clientRun(
      client,
      'Reply with exactly the word ok and nothing else.',
      cwd,
      { id: 'e2e-status' },
      realLlmConfig(),
    );
    assert.strictEqual(result.type, 'done', 'the run should complete');

    assert.deepStrictEqual(await client.status(), [], 'status should be empty again after the run finished');
  });

  it('tracks a live run via status() and aborts it with stop()', { timeout: 240000 }, async () => {
    const cwd = makeTempCwd();
    const liveRunId = 'e2e-live-run';

    // Kick off a real (multi-step) run WITHOUT awaiting so we can observe it live.
    const runPromise = client.run(
      {
        prompt: 'Create a file named greeting.txt containing exactly the text live-abort-marker and then read it back and report success.',
        cwd,
        actor: { id: 'e2e-live' },
        runId: liveRunId,
        config: realLlmConfig(),
      },
      () => undefined,
    );

    let seenActive = false;
    for (let i = 0; i < 8; i++) {
      await sleep(500);
      const runs = (await client.status()) as any[];
      const found = runs.find((r) => r.runId === liveRunId && r.active === true);
      if (found) { seenActive = true; break; }
    }
    assert.ok(seenActive, 'the run should have been observed as active while running');

    const stopped = await client.stop(liveRunId);
    assert.ok(stopped, 'stop() should report the run was stopped');

    const final: any = await runPromise;
    assert.strictEqual(final.result.type, 'aborted', `run should have been aborted, got: ${JSON.stringify(final.result)}`);
  });

  it('reports 404 for an unknown method', { timeout: 60000 }, async () => {
    const res = await fetch(server.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(request('m-no-such', 'no_such_method', {})),
      signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
    });

    const msgs = await readRawMessages(res);
    const r = msgs.find((m) => isResult(m));
    assert.ok(r, 'a result message should be present');
    assert.strictEqual((r as any).result.error.code, 404, 'unknown method should yield code 404');
  });

  it('reports 400 for a malformed (invalid JSON) body', { timeout: 60000 }, async () => {
    const res = await fetch(server.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'this is not valid json {',
      signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
    });

    const msgs = await readRawMessages(res);
    const r = msgs.find((m) => isResult(m));
    assert.ok(r, 'a result message should be present');
    assert.strictEqual((r as any).result.error.code, 400, 'malformed body should yield code 400');
  });
});
