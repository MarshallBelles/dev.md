import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { MockAPIServer, doneResponse, auditPassResponse } from './mock-server.js';
import { createInProcessTestContext, runCLI, createTestContext, getTestPort, InProcessTestContext, TestContext } from './utils.js';
import { runSubagent } from '../dist/subagent/index.js';

const TEST_PORT = getTestPort(60); // dedicated port range for this file
const CLI_TEST_PORT = getTestPort(61);

// Builds the "## Tool Input" body DELEGATE expects: a quoted label on the first
// line, then a fenced task body.
const delegateToolInput = (label: string, task: string): string =>
  `"${label}"\n\n\`\`\`\n${task}\n\`\`\``;

describe('Subagent (DELEGATE)', () => {
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
    ctx = createInProcessTestContext(TEST_PORT, { maxLoops: 20, maxRetriesAutomated: 3 });
    server.reset();
  });

  afterEach(() => {
    ctx.restoreEnv();
    ctx.cleanup();
  });

  it('spawns a subagent, blocks until it finishes, and returns its DONE summary', async () => {
    server.setGenerator((msgs, n) => {
      if (n === 1) return {
        thoughts: 'Writing the file.',
        taskList: ['[~] Write hello.txt'],
        toolChoice: 'WRITE_FILE',
        toolInput: '"hello.txt"\n\n```txt\nHello!\n```',
      };
      if (n === 2) return doneResponse('Wrote hello.txt');
      return auditPassResponse(); // subagent's own audit
    });

    const result = await runSubagent('worker', 'Write hello.txt with the content Hello!', { cwd: ctx.tempDir, automated: true });

    assert.strictEqual(result, 'Wrote hello.txt');
    assert.ok(existsSync(join(ctx.tempDir, 'hello.txt')), 'The subagent should have actually written the file');
    assert.strictEqual(readFileSync(join(ctx.tempDir, 'hello.txt'), 'utf-8').trim(), 'Hello!');
  });

  it('supports nested delegation (a subagent delegating to its own subagent)', async () => {
    server.setGenerator((msgs, n) => {
      if (n === 1) return {
        thoughts: 'This needs a focused helper.',
        taskList: [],
        toolChoice: 'DELEGATE',
        toolInput: delegateToolInput('writer', 'Write hello.txt with the content Hello!'),
      };
      if (n === 2) return {
        thoughts: 'Writing the file.',
        taskList: [],
        toolChoice: 'WRITE_FILE',
        toolInput: '"hello.txt"\n\n```txt\nHello!\n```',
      };
      if (n === 3) return doneResponse('Wrote hello.txt'); // inner subagent DONE
      if (n === 4) return auditPassResponse(); // inner subagent's audit
      if (n === 5) return doneResponse('Delegated and confirmed hello.txt was written.'); // outer subagent DONE
      return auditPassResponse(); // outer subagent's audit
    });

    const result = await runSubagent('lead', 'Get hello.txt written with the content Hello!', { cwd: ctx.tempDir, automated: true });

    assert.strictEqual(result, 'Delegated and confirmed hello.txt was written.');
    assert.ok(existsSync(join(ctx.tempDir, 'hello.txt')), 'The nested subagent should have actually written the file');
  });

  it('refuses further nesting once the delegate depth limit is reached', async () => {
    ctx.restoreEnv();
    ctx.cleanup();
    // maxDelegateDepth: 0 means the FIRST spawned subagent (depth 0, exactly like
    // one the top-level agent spawns) is allowed, but anything IT delegates
    // (depth 1) is refused - the simplest possible setup to test the guard.
    ctx = createInProcessTestContext(TEST_PORT, { maxLoops: 20, maxRetriesAutomated: 3, maxDelegateDepth: 0 });

    server.setGenerator((msgs, n) => {
      if (n === 1) return {
        thoughts: 'Delegating further.',
        taskList: [],
        toolChoice: 'DELEGATE',
        toolInput: delegateToolInput('helper', 'keep delegating'),
      };
      if (n === 2) return doneResponse('Gave up after hitting the depth limit.');
      return auditPassResponse();
    });

    const result = await runSubagent('root', 'keep delegating', { cwd: ctx.tempDir, automated: true });

    assert.strictEqual(result, 'Gave up after hitting the depth limit.');
    // The 2nd call (root reacting to its own blocked DELEGATE attempt) should
    // carry the depth limit error as a tool result - proving the block was real,
    // not just that the script happened to end.
    const secondCallMessages = server.requests[1] || [];
    const sawDepthError = secondCallMessages.some((m: any) =>
      typeof m.content === 'string' && m.content.includes('depth limit')
    );
    assert.ok(sawDepthError, 'The subagent should have seen the depth limit error as a tool result');
  });

  it('enforces the command guard within a subagent', async () => {
    server.setGenerator((msgs, n) => {
      if (n === 1) return {
        thoughts: 'Cleaning up.',
        taskList: [],
        toolChoice: 'COMMAND',
        toolInput: 'sudo rm -rf /tmp/should-not-run',
      };
      if (n === 2) return doneResponse('Could not run that command.');
      return auditPassResponse();
    });

    const result = await runSubagent('worker', 'Clean up temp files', { cwd: ctx.tempDir, automated: true });
    assert.strictEqual(result, 'Could not run that command.');

    const secondCallMessages = server.requests[1] || [];
    const sawGuardBlock = secondCallMessages.some((m: any) =>
      typeof m.content === 'string' && m.content.includes('blocked by safety guard')
    );
    assert.ok(sawGuardBlock, 'The command guard should apply inside a subagent');
  });

  it('reports a clear error for malformed DELEGATE input instead of crashing', async () => {
    server.setGenerator((msgs, n) => {
      if (n === 1) return {
        thoughts: 'Delegating without a task body.',
        taskList: [],
        toolChoice: 'DELEGATE',
        toolInput: '"helper"\n\nno code block here',
      };
      if (n === 2) return doneResponse('Could not delegate - malformed input.');
      return auditPassResponse();
    });

    const result = await runSubagent('root', 'try a malformed delegation', { cwd: ctx.tempDir, automated: true });
    assert.strictEqual(result, 'Could not delegate - malformed input.');

    const secondCallMessages = server.requests[1] || [];
    const sawFormatError = secondCallMessages.some((m: any) =>
      typeof m.content === 'string' && m.content.includes('requires a quoted label and a fenced task body')
    );
    assert.ok(sawFormatError, 'Malformed DELEGATE input should produce a clear, recoverable error');
  });
});

describe('DELEGATE via CLI (end-to-end wiring)', () => {
  let cliServer: MockAPIServer;
  let cliCtx: TestContext;

  before(async () => {
    cliServer = new MockAPIServer(() => null);
    cliServer.port = CLI_TEST_PORT;
    await cliServer.start();
  });

  after(async () => {
    await cliServer.stop();
  });

  beforeEach(() => {
    cliCtx = createTestContext(CLI_TEST_PORT);
    cliServer.reset();
  });

  afterEach(() => {
    cliCtx.cleanup();
  });

  it('lets the top-level agent delegate a task via DELEGATE and complete', async () => {
    cliServer.setGenerator((msgs, n) => {
      if (n === 1) return {
        thoughts: 'This is a self-contained task, delegating it.',
        taskList: ['[~] Delegate file write'],
        toolChoice: 'DELEGATE',
        toolInput: delegateToolInput('writer', 'Write hello.txt with the content Hello!'),
      };
      if (n === 2) return {
        thoughts: 'Writing the file.',
        taskList: [],
        toolChoice: 'WRITE_FILE',
        toolInput: '"hello.txt"\n\n```txt\nHello!\n```',
      };
      if (n === 3) return doneResponse('Wrote hello.txt'); // subagent's DONE
      if (n === 4) return auditPassResponse(); // subagent's audit
      if (n === 5) return doneResponse('The subagent finished: hello.txt was written.');
      return auditPassResponse(); // top-level (root) audit
    });

    const result = await runCLI(['-p', 'Delegate writing hello.txt to a subagent'], cliCtx, { timeout: 30000 });

    assert.strictEqual(result.exitCode, 0, `CLI should exit cleanly:\n${result.stdout}\n${result.stderr}`);
    assert.ok(result.stdout.includes('DELEGATE'), 'Should show the DELEGATE tool call');
    assert.ok(existsSync(join(cliCtx.tempDir, 'hello.txt')), 'The subagent should have actually written the file');
  });
});
