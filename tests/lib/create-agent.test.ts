import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'fs';
import { join } from 'path';
import { MockAPIServer, doneResponse, auditPassResponse } from '../mock-server.js';
import { createInProcessTestContext, InProcessTestContext, getTestPort, testFileExists } from '../utils.js';
import { createAgent } from '../../dist/lib/index.js';
import type { ToolCallInfo } from '../../dist/lib/index.js';

const TEST_PORT = getTestPort(3); // lib/create-agent.test.ts uses port 18768

interface Recorded { name: string; payload: unknown; }

const first = (recorded: Recorded[], name: string) => {
  const found = recorded.find(r => r.name === name);
  return found ? found.payload : undefined;
};

const attach = (agent: ReturnType<typeof createAgent>, sink: Recorded[]) => {
  const names = ['start','model','token','usage','parse','tool','compress','save','done','maxLoopsReached','stop','error'] as const;
  for (const name of names) {
    agent.events.on(name, (payload: unknown) => { sink.push({ name: name as string, payload }); });
  }
};

describe('lib.createAgent (Phase 1)', () => {
  let server: MockAPIServer;
  let ctx: InProcessTestContext;

  before(async () => {
    server = new MockAPIServer(() => null);
    server.port = TEST_PORT;
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(() => {
    ctx = createInProcessTestContext(TEST_PORT);
    server.reset();
  });

  afterEach(() => {
    ctx.cleanup();
    ctx.restoreEnv();
  });

  it('drives an in-process agent to DONE and emits structured events', async () => {
    const steps = [
      {
        thoughts: 'create a hello file',
        taskList: ['[~] create hello.txt'],
        toolChoice: 'WRITE_FILE',
        toolInput: `"hello.txt"\n\n\`\`\`txt\nhello world\n\`\`\``,
      },
      doneResponse('created hello.txt'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const events: Recorded[] = [];
    const agent = createAgent({
      config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 },
      cwd: ctx.tempDir,
    });
    attach(agent, events);

    const result = await agent.run({ prompt: 'create hello.txt' });

    assert.strictEqual(result.type, 'done');
    if (result.type === 'done') {
      assert.strictEqual(result.summary, 'created hello.txt');
    }
    assert.ok(testFileExists(ctx, 'hello.txt'), 'hello.txt should be written');

    const start = first(events, 'start') as { sessionId: string; cwd: string };
    assert.ok(start.sessionId, 'start event fired with sessionId');
    assert.strictEqual(typeof start.cwd, 'string');
    assert.strictEqual(events.filter(e => e.name === 'tool').length, 1, 'exactly one tool event (WRITE_FILE)');
    const done = first(events, 'done') as { summary: string };
    assert.strictEqual(done.summary, 'created hello.txt');
    // The agent should have emitted model calls and streamed at least one token.
    assert.ok(events.some(e => e.name === 'model'), 'a model request was emitted');
    assert.ok(events.some(e => e.name === 'token'), 'tokens were streamed');
  });

  it('applies inline config hermetically (does not rely on the on-disk config)', async () => {
    const steps = [
      doneResponse('done summary'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const agent = createAgent({
      config: {
        apiUrl: `http://localhost:${TEST_PORT}/v1`,
        model: 'inline-model',
        maxLoops: 10,
        maxTokens: 1234,
      },
      cwd: ctx.tempDir,
    });
    const cfg = agent.getConfig();
    assert.strictEqual(cfg.model, 'inline-model', 'inline model should win over the on-disk config');
    assert.strictEqual(cfg.maxTokens, 1234, 'inline maxTokens should be applied');
    assert.strictEqual(cfg.apiUrl, `http://localhost:${TEST_PORT}/v1`, 'inline apiUrl applied');

    const result = await agent.run({ prompt: 'noop' });
    assert.strictEqual(result.type, 'done');
  });

  it('supports onToolCall veto to skip execution', async () => {
    const steps = [
      {
        thoughts: 'touch a file we do not want written',
        taskList: ['[~] write'],
        toolChoice: 'WRITE_FILE',
        toolInput: `"secret.txt"\n\n\`\`\`txt\nforbidden\n\`\`\``,
      },
      doneResponse('done'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const seen: string[] = [];
    const agent = createAgent({
      config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 },
      cwd: ctx.tempDir,
      onToolCall: async (call: ToolCallInfo) => {
        seen.push(call.tool);
        if (call.tool === 'WRITE_FILE') return { veto: true };
      },
    });

    const result = await agent.run({ prompt: 'write secret.txt' });
    assert.strictEqual(result.type, 'done');
    assert.deepStrictEqual(seen, ['WRITE_FILE'], 'hook should have seen the tool');
    assert.ok(!testFileExists(ctx, 'secret.txt'), 'vetoed write must not happen');
  });

  it('supports onToolCall rewrite of the raw input', async () => {
    const steps = [
      {
        thoughts: 'write the rewritten content',
        taskList: ['[~] write'],
        toolChoice: 'WRITE_FILE',
        toolInput: `"rewrite.txt"\n\n\`\`\`txt\noriginal\n\`\`\``,
      },
      doneResponse('done'),
      auditPassResponse(),
    ];
    let i = 0;
    server.setGenerator(() => steps[i++] || steps[steps.length - 1]);

    const agent = createAgent({
      config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 20 },
      cwd: ctx.tempDir,
      onToolCall: (): { rewrite: string } => ({ rewrite: `"rewrite.txt"\n\n\`\`\`txt\nrewritten\n\`\`\`` }),
    });

    const result = await agent.run({ prompt: 'write rewrite.txt' });
    assert.strictEqual(result.type, 'done');
    assert.strictEqual(readFileSync(join(ctx.tempDir, 'rewrite.txt'), 'utf-8'), 'rewritten');
  });

  it('aborts when the signal is cancelled', async () => {
    // Model never says DONE; it keeps issuing a harmless READ, so the run can be
    // cancelled mid-flight.
    server.setGenerator(() => ({
      thoughts: 'thinking',
      taskList: ['[~] think'],
      toolChoice: 'READ_FILE',
      toolInput: '"anything"',
    }));

    const controller = new AbortController();
    const agent = createAgent({
      config: { apiUrl: `http://localhost:${TEST_PORT}/v1`, model: 'test-model', maxLoops: 1000 },
      cwd: ctx.tempDir,
      signal: controller.signal,
    });

    const done = agent.run({ prompt: 'long task' });
    // Let at least one model turn start, then cancel.
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const result = await done;
    assert.strictEqual(result.type, 'aborted');
  });
});
