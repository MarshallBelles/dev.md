import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { createGovernedServer } from '../dist/rpc/server.js';
import { BrowserAgentClient } from '../dist/surface/browser.js';
import { MockAPIServer, doneResponse, auditPassResponse } from './mock-server.js';
import { createInProcessTestContext, InProcessTestContext, getTestPort, testFileExists } from './utils.js';
import type { RpcEvent } from '../dist/rpc/protocol.js';

const TEST_PORT = getTestPort(11); // surface-browser.test.ts uses port 18776

describe('BrowserAgentClient (Phase 4a)', () => {
  let server: MockAPIServer;
  let ctx: InProcessTestContext;
  let httpServer: any;
  let base: string;
  let client: BrowserAgentClient;

  before(async () => {
    server = new MockAPIServer(() => null);
    server.port = TEST_PORT;
    await server.start();
    httpServer = createGovernedServer();
    const addr: any = await new Promise((resolve) => httpServer.listen(0, () => resolve(httpServer.address())));
    base = `http://localhost:${addr.port}`;
    client = new BrowserAgentClient(base);
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
  });

  it('drives a run to DONE, emitting events to subscribers', async () => {
    const steps = [
      { thoughts: 'create hello', taskList: ['[~] create'], toolChoice: 'WRITE_FILE', toolInput: `"hello.txt"\n\n\`\`\`txt\nhi\n\`\`\`` },
      doneResponse('done hello'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const seen: string[] = [];
    client.on('start', () => seen.push('start'));
    client.on('tool', () => seen.push('tool'));
    client.on('done', () => seen.push('done'));

    const { events, result } = await client.run({
      prompt: 'create hello.txt',
      cwd: ctx.tempDir,
      config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 },
      actor: { id: 'u1', scopes: ['read', 'write'] },
    });

    assert.strictEqual(result.type, 'done');
    assert.strictEqual(result.summary, 'done hello');
    assert.ok(events.some((e) => e.event === 'start'));
    assert.ok(events.some((e) => e.event === 'tool'));
    assert.ok(events.some((e) => e.event === 'done'));
    assert.deepStrictEqual(seen.includes('start') && seen.includes('tool') && seen.includes('done'), true);
    assert.ok(testFileExists(ctx, 'hello.txt'));
  });

  it('subscribes and unsubscribes from events', async () => {
    const steps = [
      { thoughts: 'x', taskList: ['[~]'], toolChoice: 'READ_FILE', toolInput: '"nothing"' },
      doneResponse('done'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    let count = 0;
    const handler = (): void => { count++; };
    client.on('tool', handler);
    await client.run({ prompt: 'noop', cwd: ctx.tempDir, config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 } as any, actor: { id: 'u1' } });
    const afterSubscribe = count;
    assert.ok(afterSubscribe >= 1);

    client.off('tool', handler);
    await client.run({ prompt: 'noop2', cwd: ctx.tempDir, config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 } as any, actor: { id: 'u1' } });
    assert.strictEqual(count, afterSubscribe, 'unsubscribed handler must not fire again');
  });

  it('executes a single tool call through the client', async () => {
    const { result } = await client.tool({
      toolName: 'WRITE_FILE',
      input: `"c.txt"\n\n\`\`\`txt\nhi\n\`\`\``,
      cwd: ctx.tempDir,
      actor: { id: 'u1' },
    });
    assert.strictEqual(result.errored, false);
    assert.match(result.outcome, /File written/);
    assert.ok(testFileExists(ctx, 'c.txt'));
  });
});
