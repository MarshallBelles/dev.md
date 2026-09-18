import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { join } from 'path';
import { MockAPIServer, doneResponse, auditPassResponse } from './mock-server.js';
import { createInProcessTestContext, InProcessTestContext, getTestPort, testFileExists, sleep } from './utils.js';
import { GovernanceEngine } from '../dist/rpc/engine.js';
import { GovernanceChain } from '../dist/governance/chain.js';
import { AuthorizationMiddleware } from '../dist/governance/middleware.js';
import { request, event, isEvent, type RpcMessage } from '../dist/rpc/protocol.js';

const TEST_PORT = getTestPort(7); // governance-engine.test.ts uses port 18772

const resultOf = (m: RpcMessage): any => (m as { result: any }).result;
const eventsOf = (m: RpcMessage[]): string[] => m.filter(isEvent).map((x) => (x as any).event);

describe('GovernanceEngine (Phase 3b)', () => {
  let server: MockAPIServer;
  let ctx: InProcessTestContext;

  before(async () => { server = new MockAPIServer(() => null); server.port = TEST_PORT; await server.start(); });
  after(async () => { await server.stop(); });
  beforeEach(() => { ctx = createInProcessTestContext(TEST_PORT); server.reset(); });
  afterEach(() => { ctx.cleanup(); ctx.restoreEnv(); });

  const engine = new GovernanceEngine();
  const denyWriteEngine = new GovernanceEngine({
    buildChain: () => new GovernanceChain([new AuthorizationMiddleware({ allowedScopes: ['read'] })]),
  });

  it('list_tools returns the governed tool catalog', () => {
    const tools = engine.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('WRITE_FILE'));
    assert.ok(names.includes('READ_FILE'));
    assert.ok(names.includes('COMMAND'));
    assert.ok(names.includes('DONE'));
  });

  it('run with no id assigns one and reports status', async () => {
    // The default generator yields 500s (retry backoff would hang), so give the
    // run a clean completion to make the id/status assertions deterministic.
    const steps = [doneResponse('noop done'), auditPassResponse()];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const sent: RpcMessage[] = [];
    const res = await engine.handle(request('x', 'run', { prompt: 'noop', cwd: ctx.tempDir, actor: { id: 'u1' } }), (m) => { sent.push(m); });
    assert.ok(typeof resultOf(res).runId === 'string');
    const status = engine.status(resultOf(res).runId);
    assert.strictEqual(status.active, false); // completed -> no longer tracked
  });

  it('stops a running run', async () => {
    // A generator that never says DONE: it keeps issuing a harmless READ so the
    // run stays pending until we stop it. An explicit runId lets us stop it
    // deterministically. maxApiRetries is capped so a cancelled fetch can never
    // stall on backoff retries.
    server.setGenerator(() => ({ thoughts: 'thinking', taskList: ['[~] think'], toolChoice: 'READ_FILE', toolInput: '"anything"' }));
    const p = { prompt: 'long', cwd: ctx.tempDir, actor: { id: 'u1' }, config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 1000, maxApiRetries: 1 } as any };
    const sent: RpcMessage[] = [];
    const runPromise = engine.handle(request('rstop', 'run', { ...p, runId: 'explicit-stop' }), (m) => { sent.push(m); });

    // The engine tracks the run synchronously when the handle begins; poll until
    // it is visible as active before we stop it.
    let active = false;
    for (let i = 0; i < 300; i++) {
      if (engine.status('explicit-stop').active) { active = true; break; }
      await sleep(10);
    }
    assert.ok(active, 'the run must be tracked as active while it is still pending');

    // Let the first loop iteration finish, then stop. Aborting once the run is
    // settled resolves in a few ms; cancelling during the very first fetch would
    // otherwise trigger backoff retries.
    await sleep(500);

    const stopped = engine.stop('explicit-stop');
    assert.strictEqual(stopped, true);

    // The cancelled run settles and the engine removes it from tracking. The
    // race is a safety net so the suite can never hang on a stuck run.
    const settled = Promise.race([runPromise.then(() => 'settled'), sleep(15000).then(() => 'timeout')]);
    const res = await settled;
    assert.notStrictEqual(res, 'timeout', 'the run should settle shortly after being stopped');
    assert.strictEqual(engine.status('explicit-stop').active, false);
  });

  it('drives a governed run to DONE and emits structured events', async () => {
    const steps = [
      { thoughts: 'create a hello file', taskList: ['[~] create hello.txt'], toolChoice: 'WRITE_FILE', toolInput: `"hello.txt"\n\n\`\`\`txt\nhello world\n\`\`\`` },
      doneResponse('created hello.txt'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const sent: RpcMessage[] = [];
    const res = await engine.handle(request('run-1', 'run', {
      prompt: 'create hello.txt',
      cwd: ctx.tempDir,
      config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 } as any,
      actor: { id: 'u1', scopes: ['read', 'write'] },
    }), (m) => { sent.push(m); });

    assert.strictEqual(resultOf(res).type, 'done');
    assert.strictEqual(resultOf(res).summary, 'created hello.txt');
    const evs = eventsOf(sent);
    assert.ok(evs.includes('start'));
    assert.ok(evs.includes('tool'));
    assert.ok(evs.includes('done'));
    assert.ok(testFileExists(ctx, 'hello.txt'));
  });

  it('denies a mutating tool when the chain does not allow its capability (fail closed)', async () => {
    const steps = [
      { thoughts: 'write a secret', taskList: ['[~] write'], toolChoice: 'WRITE_FILE', toolInput: `"secret.txt"\n\n\`\`\`txt\nforbidden\n\`\`\`` },
      doneResponse('done'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const sent: RpcMessage[] = [];
    const res = await denyWriteEngine.handle(request('run-2', 'run', {
      prompt: 'write secret.txt',
      cwd: ctx.tempDir,
      config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 } as any,
      actor: { id: 'u1', scopes: ['write'] },
    }), (m) => { sent.push(m); });

    assert.strictEqual(resultOf(res).type, 'done');
    const toolEvents = sent.filter((m) => isEvent(m) && (m as any).event === 'tool') as unknown as { payload: { result: string } }[];
    assert.ok(toolEvents.length >= 1);
    assert.match(toolEvents[0].payload.result, /denied by governance/);
    assert.ok(!testFileExists(ctx, 'secret.txt'), 'a denied write must not hit the filesystem');
  });

  it('executes a single governed tool call (tool method)', async () => {
    const res = await engine.handle(request('t1', 'tool', {
      toolName: 'WRITE_FILE',
      input: `"single.txt"\n\n\`\`\`txt\nhi\n\`\`\``,
      cwd: ctx.tempDir,
      actor: { id: 'u1' },
    }), () => undefined);
    const r = resultOf(res);
    assert.strictEqual(r.errored, false);
    assert.match(r.outcome, /File written/);
    assert.ok(testFileExists(ctx, 'single.txt'));
  });

  it('denies a single governed tool call (tool method, fail closed)', async () => {
    const res = await denyWriteEngine.handle(request('t2', 'tool', {
      toolName: 'WRITE_FILE',
      input: `"no.txt"\n\n\`\`\`txt\nx\n\`\`\``,
      cwd: ctx.tempDir,
      actor: { id: 'u1', scopes: ['write'] },
    }), () => undefined);
    const r = resultOf(res);
    assert.strictEqual(r.errored, true);
    assert.match(r.outcome, /denied by governance/);
    assert.ok(!testFileExists(ctx, 'no.txt'));
  });

  it('returns 404 for an unknown tool in the tool method', async () => {
    const res = await engine.handle(request('t3', 'tool', { toolName: 'NO_SUCH', input: '{}', cwd: ctx.tempDir, actor: { id: 'u1' } }), () => undefined);
    assert.strictEqual(resultOf(res).error.code, 404);
  });
});
