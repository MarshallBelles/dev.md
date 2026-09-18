import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createGovernedServer } from '../dist/rpc/server.js';
import { GovernanceClient } from '../dist/rpc/client.js';
import { Fleet, InMemoryFleetStore } from '../dist/surface/fleet.js';
import { MockAPIServer, doneResponse, auditPassResponse, formatAgentResponse } from './mock-server.js';
import { createInProcessTestContext, InProcessTestContext, getTestPort } from './utils.js';

const TEST_PORT = getTestPort(15); // surface-fleet.test.ts uses port 18782

const readForever = formatAgentResponse({ thoughts: 'keep going', taskList: ['[~]'], toolChoice: 'READ_FILE', toolInput: '"nothing"' });

describe('Fleet (Phase 4c)', () => {
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
    // A successful run consumes exactly 2 mock calls: one DONE for the main
    // loop, one audit-pass for the audit step. Key on the "Begin the audit."
    // message (not requestNum parity) so the generator stays correct under the
    // shared counter that concurrent runs share.
    server.setGenerator((messages) => {
      const last = messages[messages.length - 1];
      if (last && last.content === 'Begin the audit.') return auditPassResponse();
      return doneResponse('done');
    });
  });

  afterEach(() => {
    ctx.cleanup();
    ctx.restoreEnv();
  });

  const cfg = (over: Record<string, unknown> = {}) => ({
    apiUrl: `http://localhost:${TEST_PORT}/v1`,
    model: 'test-model',
    maxLoops: 20,
    maxRetriesAutomated: 3,
    ...over,
  });

  it('spawns runs and reports all done', async () => {
    const fleet = new Fleet(client, new InMemoryFleetStore());
    const a = fleet.spawn('task a', ctx.tempDir, { id: 'u1' }, cfg());
    const b = fleet.spawn('task b', ctx.tempDir, { id: 'u1' }, cfg());
    const outcomes = await fleet.waitForAll();

    assert.strictEqual(outcomes.length, 2);
    assert.ok(outcomes.every((o) => o.type === 'done'));
    const st = fleet.status();
    assert.strictEqual(st.total, 2);
    assert.strictEqual(st.done, 2);
    assert.strictEqual(st.running, 0);
    assert.strictEqual(fleet.sessions().length, 2);
    assert.ok(a.sessionId && b.sessionId && a.sessionId !== b.sessionId);
  });

  it('tracks a run that exhausts maxLoops', async () => {
    server.setGenerator(() => readForever); // never DONE -> maxLoopsReached
    const fleet = new Fleet(client, new InMemoryFleetStore());
    const r = fleet.spawn('loop', ctx.tempDir, { id: 'u1' }, {
      apiUrl: `http://localhost:${TEST_PORT}/v1`,
      model: 'test-model',
      maxLoops: 3,
      maxRetriesAutomated: 1,
    });
    const outcome = await r.promise;
    assert.strictEqual(outcome.type, 'maxLoopsReached');
    const st = fleet.status();
    assert.strictEqual(st.maxLoops, 1);
    assert.strictEqual(st.done, 0);
  });

  it('exposes sessions with actor + persisted status', async () => {
    const fleet = new Fleet(client, new InMemoryFleetStore());
    const r = fleet.spawn('persisted', ctx.tempDir, { id: 'u1', tenantId: 't1' }, cfg());
    await r.promise;

    const s = fleet.load(r.sessionId);
    assert.ok(s);
    assert.strictEqual(s.originalPrompt, 'persisted');
    assert.strictEqual(s.actor?.tenantId, 't1');
    assert.strictEqual(s.status, 'done');
    assert.strictEqual(fleet.status().total, 1);
  });
});
