import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MockAPIServer, doneResponse, auditPassResponse, MockResponse } from './mock-server.js';
import { createTestContext, runCLI, readTestFile, writeTestFile, testFileExists, getSessionFile, listSessionFiles, TestContext, sleep, getTestPort } from './utils.js';

const TEST_PORT = getTestPort(2); // sessions.test.ts uses port 18767

describe('Multi-Session Tests', () => {
  let server: MockAPIServer;
  let ctx: TestContext;

  before(async () => {
    server = new MockAPIServer(() => null);
    server.port = TEST_PORT;
    await server.start();
  });

  after(async () => {
    await server.stop();
  });

  beforeEach(() => {
    ctx = createTestContext(TEST_PORT);
    server.reset();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  describe('Session Creation and Persistence', () => {
    it('should create a new session with UUID', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return doneResponse('Quick task completed');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Quick task'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.sessionId, 'Should have session ID');
      assert.ok(result.sessionId.match(/^[a-f0-9-]+$/), 'Session ID should be UUID format');
    });

    it('should persist session to disk', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return doneResponse('Task done');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Persist me'], ctx);
      const session = getSessionFile(ctx, result.sessionId!);

      assert.ok(session, 'Session file should exist');
      assert.strictEqual(session.id, result.sessionId);
      assert.strictEqual(session.originalPrompt, 'Persist me');
      assert.ok(session.history.length > 0, 'History should be populated');
    });

    it('should track multiple sessions', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return doneResponse('Done');
        return auditPassResponse();
      });

      const result1 = await runCLI(['-p', 'Task 1'], ctx);
      server.reset();
      const result2 = await runCLI(['-p', 'Task 2'], ctx);
      server.reset();
      const result3 = await runCLI(['-p', 'Task 3'], ctx);

      const sessions = listSessionFiles(ctx);
      assert.ok(sessions.length >= 3, 'Should have at least 3 sessions');
      assert.notStrictEqual(result1.sessionId, result2.sessionId);
      assert.notStrictEqual(result2.sessionId, result3.sessionId);
    });
  });

  describe('Session Resume with --session', () => {
    it('should resume existing session by UUID', async () => {
      let requestCount = 0;
      server.setGenerator((msgs, n) => {
        requestCount++;
        if (requestCount === 1) return {
          thoughts: 'Starting task, creating file.',
          taskList: ['[~] Create file', '[ ] Verify'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"step1.txt"\n\n\`\`\`txt\nStep 1 content\n\`\`\``,
        };
        if (requestCount === 2) return doneResponse('Step 1 complete');
        if (requestCount === 3) return auditPassResponse();
        // Resumed session
        if (requestCount === 4) return {
          thoughts: 'Continuing from where we left off.',
          taskList: ['[x] Create file', '[~] Add more'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"step2.txt"\n\n\`\`\`txt\nStep 2 content\n\`\`\``,
        };
        if (requestCount === 5) return doneResponse('Step 2 complete');
        return auditPassResponse();
      });

      // First session
      const result1 = await runCLI(['-p', 'Create step 1'], ctx);
      assert.strictEqual(result1.exitCode, 0);
      const sessionId = result1.sessionId!;

      // Resume with --session
      const result2 = await runCLI(['--session', sessionId, '-p', 'Now add step 2'], ctx);
      assert.strictEqual(result2.exitCode, 0);

      // Verify both files exist
      assert.ok(testFileExists(ctx, 'step1.txt'), 'step1.txt should exist');
      assert.ok(testFileExists(ctx, 'step2.txt'), 'step2.txt should exist');

      // Verify session has combined history
      const session = getSessionFile(ctx, sessionId);
      assert.ok(session.history.length >= 4, 'Should have combined history');
    });

    it('should maintain context across resumed sessions', async () => {
      let callNum = 0;
      server.setGenerator((msgs, n) => {
        callNum++;
        // First session: read and store info
        if (callNum === 1) return {
          thoughts: 'Reading the config file.',
          taskList: ['[~] Read config'],
          toolChoice: 'READ_FILE',
          toolInput: '"config.json"',
        };
        if (callNum === 2) return doneResponse('Read config: name is "test-app", version is "1.0.0"');
        if (callNum === 3) return auditPassResponse();

        // Resumed: modify based on previous context
        if (callNum === 4) return {
          thoughts: 'Updating the version based on previous read.',
          taskList: ['[x] Read config', '[~] Update version'],
          toolChoice: 'FIND_AND_REPLACE_IN_FILE',
          toolInput: `"config.json"\n\n\`\`\`find\n"1.0.0"\n\`\`\`\n\n\`\`\`replace\n"2.0.0"\n\`\`\``,
        };
        if (callNum === 5) return doneResponse('Updated version to 2.0.0');
        return auditPassResponse();
      });

      writeTestFile(ctx, 'config.json', '{"name": "test-app", "version": "1.0.0"}');

      const result1 = await runCLI(['-p', 'Read the config'], ctx);
      const sessionId = result1.sessionId!;

      const result2 = await runCLI(['--session', sessionId, '-p', 'Now update the version to 2.0.0'], ctx);
      assert.strictEqual(result2.exitCode, 0);

      const content = readTestFile(ctx, 'config.json');
      assert.ok(content?.includes('2.0.0'), 'Version should be updated');
    });

    it('should fail gracefully with invalid session ID', async () => {
      const result = await runCLI(['--session', 'invalid-uuid-here', '-p', 'Test'], ctx);
      assert.ok(result.exitCode !== 0 || result.stdout.includes('not found'), 'Should fail or report not found');
    });
  });

  describe('Multi-Chat Automation Workflow', () => {
    it('should support n8n-style automation with fixed session ID', async () => {
      const fixedSessionId = 'automation-session-001';
      let callNum = 0;

      server.setGenerator((msgs, n) => {
        callNum++;
        if (callNum === 1) return {
          thoughts: 'Automation step 1: Initialize project.',
          taskList: ['[~] Init'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"project.json"\n\n\`\`\`json\n{"initialized": true, "steps": []}\n\`\`\``,
        };
        if (callNum === 2) return doneResponse('Initialized project');
        if (callNum === 3) return auditPassResponse();

        if (callNum === 4) return {
          thoughts: 'Automation step 2: Add first step.',
          taskList: ['[x] Init', '[~] Add step 1'],
          toolChoice: 'READ_FILE',
          toolInput: '"project.json"',
        };
        if (callNum === 5) return {
          thoughts: 'Updating project with step 1.',
          taskList: ['[x] Init', '[~] Add step 1'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"project.json"\n\n\`\`\`json\n{"initialized": true, "steps": ["step1"]}\n\`\`\``,
        };
        if (callNum === 6) return doneResponse('Added step 1');
        if (callNum === 7) return auditPassResponse();

        if (callNum === 8) return {
          thoughts: 'Automation step 3: Add second step.',
          taskList: ['[x] Init', '[x] Add step 1', '[~] Add step 2'],
          toolChoice: 'READ_FILE',
          toolInput: '"project.json"',
        };
        if (callNum === 9) return {
          thoughts: 'Updating project with step 2.',
          taskList: ['[x] Init', '[x] Add step 1', '[~] Add step 2'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"project.json"\n\n\`\`\`json\n{"initialized": true, "steps": ["step1", "step2"]}\n\`\`\``,
        };
        if (callNum === 10) return doneResponse('Added step 2');
        return auditPassResponse();
      });

      // Simulate n8n workflow: multiple automated calls with same session
      // First call creates the session
      const r1 = await runCLI(['-p', 'Initialize the project'], ctx);
      assert.strictEqual(r1.exitCode, 0);
      const sessionId = r1.sessionId!;

      // Second call uses --session
      const r2 = await runCLI(['--session', sessionId, '-p', 'Add step 1 to the project'], ctx);
      assert.strictEqual(r2.exitCode, 0);

      // Third call continues
      const r3 = await runCLI(['--session', sessionId, '-p', 'Add step 2 to the project'], ctx);
      assert.strictEqual(r3.exitCode, 0);

      // Verify final state
      const content = readTestFile(ctx, 'project.json');
      const parsed = JSON.parse(content!);
      assert.ok(parsed.initialized, 'Should be initialized');
      assert.deepStrictEqual(parsed.steps, ['step1', 'step2'], 'Should have both steps');

      // Verify session history accumulates
      const session = getSessionFile(ctx, sessionId);
      assert.ok(session.history.length >= 6, 'Should have accumulated history');
    });

    it('should preserve working directory context', async () => {
      let callNum = 0;
      server.setGenerator(() => {
        callNum++;
        if (callNum === 1) return {
          thoughts: 'Creating in working directory.',
          taskList: ['[~] Create'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"test.txt"\n\n\`\`\`txt\ntest\n\`\`\``,
        };
        if (callNum === 2) return doneResponse('Created file');
        if (callNum === 3) return auditPassResponse();
        if (callNum === 4) return {
          thoughts: 'Listing directory.',
          taskList: ['[~] List'],
          toolChoice: 'LIST_DIRECTORY',
          toolInput: '"."',
        };
        if (callNum === 5) return doneResponse('Listed directory');
        return auditPassResponse();
      });

      const r1 = await runCLI(['-p', 'Create test.txt'], ctx);
      const sessionId = r1.sessionId!;

      const r2 = await runCLI(['--session', sessionId, '-p', 'List files'], ctx);
      assert.ok(r2.stdout.includes('test.txt'), 'Should see file in same directory');

      const session = getSessionFile(ctx, sessionId);
      assert.strictEqual(session.workingDirectory, ctx.tempDir, 'Working directory should be preserved');
    });
  });

  describe('Session Resume with --resume', () => {
    it('should resume last session in directory', async () => {
      let callNum = 0;
      server.setGenerator(() => {
        callNum++;
        if (callNum === 1) return {
          thoughts: 'Creating initial file.',
          taskList: ['[~] Create'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"initial.txt"\n\n\`\`\`txt\ninitial\n\`\`\``,
        };
        if (callNum === 2) return doneResponse('Created initial.txt');
        if (callNum === 3) return auditPassResponse();
        if (callNum === 4) return {
          thoughts: 'Adding to the work.',
          taskList: ['[x] Create initial', '[~] Add more'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"followup.txt"\n\n\`\`\`txt\nfollowup\n\`\`\``,
        };
        if (callNum === 5) return doneResponse('Added followup');
        return auditPassResponse();
      });

      const r1 = await runCLI(['-p', 'Create initial file'], ctx);
      const originalId = r1.sessionId!;

      // Use --resume instead of --session
      const r2 = await runCLI(['--resume', '-p', 'Add followup file'], ctx);
      assert.ok(r2.stdout.includes(originalId.slice(0, 8)) || r2.stdout.includes('Resumed'), 'Should resume same session');

      assert.ok(testFileExists(ctx, 'initial.txt'), 'Initial file should exist');
      assert.ok(testFileExists(ctx, 'followup.txt'), 'Followup file should exist');
    });
  });

  describe('Session History Accumulation', () => {
    it('should accumulate tool results in history', async () => {
      let callNum = 0;
      server.setGenerator(() => {
        callNum++;
        if (callNum === 1) return {
          thoughts: 'Reading file.',
          taskList: ['[~] Read'],
          toolChoice: 'READ_FILE',
          toolInput: '"data.txt"',
        };
        if (callNum === 2) return doneResponse('Read the data');
        if (callNum === 3) return auditPassResponse();
        if (callNum === 4) return {
          thoughts: 'Reading another file.',
          taskList: ['[~] Read more'],
          toolChoice: 'READ_FILE',
          toolInput: '"more.txt"',
        };
        if (callNum === 5) return doneResponse('Read more data');
        return auditPassResponse();
      });

      writeTestFile(ctx, 'data.txt', 'DATA_CONTENT_123');
      writeTestFile(ctx, 'more.txt', 'MORE_CONTENT_456');

      const r1 = await runCLI(['-p', 'Read data.txt'], ctx);
      const sessionId = r1.sessionId!;

      const r2 = await runCLI(['--session', sessionId, '-p', 'Read more.txt'], ctx);

      const session = getSessionFile(ctx, sessionId);
      const historyStr = JSON.stringify(session.history);

      // Tool results should be in history
      assert.ok(historyStr.includes('DATA_CONTENT_123'), 'First file content should be in history');
      assert.ok(historyStr.includes('MORE_CONTENT_456'), 'Second file content should be in history');
    });

    it('should track total tokens across session', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return doneResponse('Done 1');
        if (n === 2) return auditPassResponse();
        if (n === 3) return doneResponse('Done 2');
        return auditPassResponse();
      });

      const r1 = await runCLI(['-p', 'Task 1'], ctx);
      const session1 = getSessionFile(ctx, r1.sessionId!);
      const tokens1 = session1.totalTokens;

      const r2 = await runCLI(['--session', r1.sessionId!, '-p', 'Task 2'], ctx);
      const session2 = getSessionFile(ctx, r1.sessionId!);
      const tokens2 = session2.totalTokens;

      assert.ok(tokens2 > tokens1, 'Total tokens should accumulate');
    });
  });

  describe('Session List Command', () => {
    it('should list all sessions', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return doneResponse('Done');
        return auditPassResponse();
      });

      await runCLI(['-p', 'Session A'], ctx);
      server.reset();
      await runCLI(['-p', 'Session B'], ctx);
      server.reset();
      await runCLI(['-p', 'Session C'], ctx);

      const result = await runCLI(['sessions', 'list'], ctx);
      assert.ok(result.stdout.includes('Session A') || result.stdout.includes('Sessions'), 'Should list sessions');
    });
  });

  describe('Edge Cases', () => {
    it('should handle empty prompt with --session', async () => {
      server.setGenerator(() => doneResponse('Handled empty'));

      const r1 = await runCLI(['-p', 'Initial'], ctx);
      // This might error or handle gracefully depending on implementation
      // Just verify it doesn't crash
      try {
        await runCLI(['--session', r1.sessionId!, '-p', ''], ctx);
      } catch {
        // Expected to possibly fail
      }
    });

    it('should handle rapid sequential session calls', async () => {
      let counter = 0;
      server.setGenerator(() => {
        counter++;
        return doneResponse(`Call ${counter}`);
      });

      const r1 = await runCLI(['-p', 'First'], ctx);
      const sessionId = r1.sessionId!;

      // Rapid sequential calls
      await Promise.all([
        runCLI(['--session', sessionId, '-p', 'A'], ctx),
        sleep(50).then(() => runCLI(['--session', sessionId, '-p', 'B'], ctx)),
        sleep(100).then(() => runCLI(['--session', sessionId, '-p', 'C'], ctx)),
      ]);

      // Verify session file isn't corrupted
      const session = getSessionFile(ctx, sessionId);
      assert.ok(session, 'Session should still be valid');
      assert.ok(session.history.length > 0, 'History should exist');
    });
  });
});
