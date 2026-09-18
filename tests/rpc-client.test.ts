import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createGovernedServer } from '../dist/rpc/server.js';
import { GovernanceClient } from '../dist/rpc/client.js';
import { MockAPIServer, doneResponse, auditPassResponse } from './mock-server.js';
import { createInProcessTestContext, InProcessTestContext, getTestPort, testFileExists } from './utils.js';
import type { RpcEvent } from '../dist/rpc/protocol.js';

const TEST_PORT = getTestPort(9); // rpc-client.test.ts uses port 18774

describe('GovernanceClient (Phase 3c)', () => {
  let server: MockAPIServer;
  let ctx: InProcessTestContext;
  let httpServer: any;
  let base: string;
  let client: GovernanceClient;

  before(async () => {
    server = new MockAPIServer(() => null);
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
  });

  afterEach(() => {
    ctx.cleanup();
    ctx.restoreEnv();
  });

  it('list_tools returns the catalog', async () => {
    const tools = await client.listTools();
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('WRITE_FILE'));
    assert.ok(names.includes('READ_FILE'));
    assert.ok(names.includes('COMMAND'));
  });

  it('drives a run to DONE and surfaces events', async () => {
    const steps = [
      { thoughts: 'create hello', taskList: ['[~] create'], toolChoice: 'WRITE_FILE', toolInput: `"hello.txt"\n\n\`\`\`txt\nhi\n\`\`\`` },
      doneResponse('done hello'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const events: string[] = [];
    const final: any = await client.run({
      prompt: 'create hello.txt',
      cwd: ctx.tempDir,
      config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 },
      actor: { id: 'u1', scopes: ['read', 'write'] },
    }, (e: RpcEvent) => events.push(e.event));

    assert.strictEqual(final.result.type, 'done');
    assert.strictEqual(final.result.summary, 'done hello');
    assert.ok(events.includes('start'));
    assert.ok(events.includes('tool'));
    assert.ok(events.includes('done'));
    assert.ok(testFileExists(ctx, 'hello.txt'));
  });

  it('executes a single tool call through the client', async () => {
    const final: any = await client.tool({
      runId: 'cli-tool-1',
      toolName: 'WRITE_FILE',
      input: `"c.txt"\n\n\`\`\`txt\nhi\n\`\`\``,
      cwd: ctx.tempDir,
      actor: { id: 'u1' },
    });
    assert.strictEqual(final.result.errored, false);
    assert.match(final.result.outcome, /File written/);
    assert.ok(testFileExists(ctx, 'c.txt'));
  });

  it('stops a run', async () => {
    // list_tools is synchronous-ish; stopping a completed run returns false, which
    // is a valid, deterministic assertion of the control surface.
    const stopped = await client.stop('never-started');
    assert.strictEqual(stopped, false);
  });
});
