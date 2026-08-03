import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { MockAPIServer, createScriptedServer, doneResponse, auditPassResponse, formatAgentResponse, MockResponse } from './mock-server.js';
import { createTestContext, runCLI, readTestFile, writeTestFile, testFileExists, TestContext, sleep, getTestPort } from './utils.js';

const TEST_PORT = getTestPort(0); // tools.test.ts uses port 18765

describe('Tool Tests', () => {
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

  describe('LIST_DIRECTORY', () => {
    it('should list files in a directory', async () => {
      writeTestFile(ctx, 'src/index.ts', 'console.log("hello");');
      writeTestFile(ctx, 'src/utils.ts', 'export const x = 1;');
      writeTestFile(ctx, 'README.md', '# Test');

      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Let me list the directory contents.',
          taskList: ['[~] List directory'],
          toolChoice: 'LIST_DIRECTORY',
          toolInput: '"."',
        };
        if (n === 2) return doneResponse('Listed the directory successfully. Found src/ folder and README.md');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'List files'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('src') || result.stdout.includes('README'), 'Should show directory contents');
    });

    it('should support glob patterns', async () => {
      writeTestFile(ctx, 'src/a.ts', '');
      writeTestFile(ctx, 'src/b.ts', '');
      writeTestFile(ctx, 'src/nested/c.ts', '');
      writeTestFile(ctx, 'other/d.js', '');

      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Using glob to find TypeScript files.',
          taskList: ['[~] Find TS files'],
          toolChoice: 'LIST_DIRECTORY',
          toolInput: '"src/**/*.ts"',
        };
        if (n === 2) return doneResponse('Found 3 TypeScript files in src/');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Find all TS files'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('a.ts') || result.stdout.includes('.ts'), 'Should find TS files');
    });
  });

  describe('READ_FILE', () => {
    it('should read file contents', async () => {
      writeTestFile(ctx, 'config.json', '{"name": "test-project"}');

      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Reading the config file.',
          taskList: ['[~] Read config'],
          toolChoice: 'READ_FILE',
          toolInput: '"config.json"',
        };
        if (n === 2) return doneResponse('Read config.json - it contains project name "test-project"');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Read config'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('test-project'), 'Should show file contents');
    });

    it('should handle non-existent files', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Trying to read a file that may not exist.',
          taskList: ['[~] Read file'],
          toolChoice: 'READ_FILE',
          toolInput: '"nonexistent.txt"',
        };
        if (n === 2) return doneResponse('File does not exist');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Read nonexistent file'], ctx);
      assert.ok(result.stdout.includes('not found') || result.stdout.includes('File not found'), 'Should report file not found');
    });
  });

  describe('WRITE_FILE', () => {
    it('should create a new file', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Creating a new TypeScript file.',
          taskList: ['[~] Create file'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"src/hello.ts"

\`\`\`ts
export const greet = (name: string) => \`Hello, \${name}!\`;
\`\`\``,
        };
        if (n === 2) return doneResponse('Created src/hello.ts with greet function');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Create hello.ts'], ctx);
      assert.strictEqual(result.exitCode, 0);

      const content = readTestFile(ctx, 'src/hello.ts');
      assert.ok(content !== null, 'File should be created');
      assert.ok(content.includes('greet'), 'File should contain greet function');
      assert.ok(content.includes('Hello'), 'File should contain Hello string');
    });

    it('should overwrite existing file', async () => {
      writeTestFile(ctx, 'data.txt', 'old content');

      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Overwriting the file.',
          taskList: ['[~] Update file'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"data.txt"

\`\`\`txt
new content here
\`\`\``,
        };
        if (n === 2) return doneResponse('Updated data.txt');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Update data.txt'], ctx);
      assert.strictEqual(result.exitCode, 0);

      const content = readTestFile(ctx, 'data.txt');
      assert.ok(content?.includes('new content'), 'File should have new content');
      assert.ok(!content?.includes('old content'), 'Old content should be gone');
    });

    it('should create nested directories', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Creating file in nested path.',
          taskList: ['[~] Create nested file'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"a/b/c/deep.txt"

\`\`\`txt
deep file
\`\`\``,
        };
        if (n === 2) return doneResponse('Created deeply nested file');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Create nested file'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(testFileExists(ctx, 'a/b/c/deep.txt'), 'Nested file should exist');
    });
  });

  describe('FIND_AND_REPLACE_IN_FILE', () => {
    it('should find and replace text', async () => {
      writeTestFile(ctx, 'code.ts', 'const oldVar = 42;\nconsole.log(oldVar);');

      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Renaming variable.',
          taskList: ['[~] Rename var'],
          toolChoice: 'FIND_AND_REPLACE_IN_FILE',
          toolInput: `"code.ts"

\`\`\`find
oldVar
\`\`\`

\`\`\`replace
newVar
\`\`\``,
        };
        if (n === 2) return doneResponse('Renamed oldVar to newVar');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Rename variable'], ctx);
      assert.strictEqual(result.exitCode, 0);

      const content = readTestFile(ctx, 'code.ts');
      assert.ok(content?.includes('newVar'), 'Should have new variable name');
      assert.ok(!content?.includes('oldVar'), 'Should not have old variable name');
    });

    it('should replace multiple occurrences', async () => {
      writeTestFile(ctx, 'multi.txt', 'foo bar foo baz foo');

      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Replacing all foo with qux.',
          taskList: ['[~] Replace all'],
          toolChoice: 'FIND_AND_REPLACE_IN_FILE',
          toolInput: `"multi.txt"

\`\`\`find
foo
\`\`\`

\`\`\`replace
qux
\`\`\``,
        };
        if (n === 2) return doneResponse('Replaced 3 occurrences');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Replace foo'], ctx);
      assert.strictEqual(result.exitCode, 0);

      const content = readTestFile(ctx, 'multi.txt');
      assert.strictEqual(content, 'qux bar qux baz qux', 'All occurrences should be replaced');
    });

    it('should handle special regex characters in find string', async () => {
      writeTestFile(ctx, 'special.ts', 'const x = [1,2]; console.log(a+b);');

      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Replacing special chars.',
          taskList: ['[~] Replace'],
          toolChoice: 'FIND_AND_REPLACE_IN_FILE',
          toolInput: `"special.ts"

\`\`\`find
[1,2]
\`\`\`

\`\`\`replace
[3,4]
\`\`\``,
        };
        if (n === 2) return doneResponse('Replaced brackets');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Replace brackets'], ctx);
      assert.strictEqual(result.exitCode, 0);

      const content = readTestFile(ctx, 'special.ts');
      assert.ok(content?.includes('[3,4]'), 'Should replace bracket content');
      assert.ok(!content?.includes('[1,2]'), 'Original should be gone');
    });
  });

  describe('COMMAND', () => {
    it('should execute simple commands', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Running echo command.',
          taskList: ['[~] Run command'],
          toolChoice: 'COMMAND',
          toolInput: 'echo "hello from test"',
        };
        if (n === 2) return doneResponse('Command executed successfully');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Run echo'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('hello from test'), 'Should show command output');
    });

    it('should execute commands with code blocks', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Running command in code block.',
          taskList: ['[~] Run command'],
          toolChoice: 'COMMAND',
          toolInput: `\`\`\`bash
echo "line1" && echo "line2"
\`\`\``,
        };
        if (n === 2) return doneResponse('Commands executed');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Run commands'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('line1'), 'Should show first output');
      assert.ok(result.stdout.includes('line2'), 'Should show second output');
    });

    it('should capture command errors', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Running command that will fail.',
          taskList: ['[~] Run failing command'],
          toolChoice: 'COMMAND',
          toolInput: 'exit 1',
        };
        if (n === 2) return doneResponse('Command failed as expected');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Run failing command'], ctx);
      assert.ok(result.stdout.includes('Exit code') || result.stdout.includes('exit'), 'Should show exit code');
    });
  });

  describe('Command Guard', () => {
    it('blocks a destructive command targeting an absolute path outside the working directory', async () => {
      // The deterministic denylist is on by default (commandGuardEnabled) with no
      // config override needed. Prove the block is real, not just cosmetic, by
      // pointing the scripted command at a real file OUTSIDE ctx.tempDir and
      // confirming it survives the run.
      const decoyDir = mkdtempSync(join(tmpdir(), 'dev-md-guard-decoy-'));
      const decoyFile = join(decoyDir, 'must-survive.txt');
      writeFileSync(decoyFile, 'do not delete me');

      try {
        server.setGenerator((msgs, n) => {
          if (n === 1) return {
            thoughts: 'Deleting an unrelated path.',
            taskList: ['[~] Delete path'],
            toolChoice: 'COMMAND',
            toolInput: `rm -rf ${decoyFile}`,
          };
          if (n === 2) return doneResponse('Could not complete that operation - it was blocked.');
          return auditPassResponse();
        });

        const result = await runCLI(['-p', 'Delete a file outside the project'], ctx);
        assert.strictEqual(result.exitCode, 0);
        assert.ok(result.stdout.includes('blocked by safety guard'), 'Should report the command was blocked');
        assert.ok(existsSync(decoyFile), 'The file outside the working directory must survive');
      } finally {
        rmSync(decoyDir, { recursive: true, force: true });
      }
    });

    it('still allows normal file deletion within the working directory', async () => {
      writeTestFile(ctx, 'scratch.txt', 'temporary');

      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Deleting a scratch file in the project.',
          taskList: ['[~] Clean up'],
          toolChoice: 'COMMAND',
          toolInput: 'rm scratch.txt',
        };
        if (n === 2) return doneResponse('Removed scratch.txt');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Clean up scratch file'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(!result.stdout.includes('blocked by safety guard'), 'A normal in-project delete should not be blocked');
      assert.strictEqual(testFileExists(ctx, 'scratch.txt'), false, 'The file should actually have been deleted');
    });
  });

  describe('UPDATE_TASK_LIST', () => {
    it('should update task list without input', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return {
          thoughts: 'Updating my task list.',
          taskList: ['[x] Step 1', '[~] Step 2', '[ ] Step 3'],
          toolChoice: 'UPDATE_TASK_LIST',
          toolInput: '',
        };
        if (n === 2) return doneResponse('Task list updated');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Update tasks'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('Step 1') || result.stdout.includes('Task'), 'Should show task list');
    });
  });

  describe('DONE', () => {
    it('should trigger audit and complete', async () => {
      server.setGenerator((msgs, n) => {
        if (n === 1) return doneResponse('Completed the requested task successfully.');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Complete task'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('PASS') || result.stdout.includes('complete'), 'Should show completion');
    });

    it('should retry on audit failure', async () => {
      let callCount = 0;
      server.setGenerator((msgs, n) => {
        callCount++;
        if (callCount === 1) return doneResponse('Done with task');
        if (callCount === 2) return `| Check | Status |
|-------|--------|
| Verify | FAIL |

Overall: FAIL
Feedback: Missing verification step.`;
        if (callCount === 3) return {
          thoughts: 'Need to fix the issue.',
          taskList: ['[~] Fix issue'],
          toolChoice: 'COMMAND',
          toolInput: 'echo "fixed"',
        };
        if (callCount === 4) return doneResponse('Fixed and completed');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Task with retry'], ctx);
      assert.ok(callCount >= 3, 'Should have multiple calls due to audit failure');
    });

    it('should not treat a malformed/unparseable audit response as passed', async () => {
      // Regression test: the audit must fail closed (retry) when its response can't be
      // parsed and contains no clear "Overall: PASS"/"Overall: FAIL" verdict - it must
      // never silently default to passed just because the response didn't say "fail".
      let callCount = 0;
      server.setGenerator((msgs, n) => {
        callCount++;
        if (callCount === 1) return doneResponse('Completed the requested task.');
        if (callCount === 2) return 'Some incoherent garbled output with no clear verdict at all.';
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Complete task'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(callCount >= 3, 'A malformed audit response must trigger a retry, not an immediate pass');
    });

    it('should not treat an ambiguous DONE verdict lacking an explicit PASS as passed', async () => {
      // Regression test: even a well-formed audit DONE call must require an explicit
      // "Overall: PASS" - merely not containing the word "fail" is not enough.
      let callCount = 0;
      server.setGenerator((msgs, n) => {
        callCount++;
        if (callCount === 1) return doneResponse('Completed the requested task.');
        if (callCount === 2) return formatAgentResponse({
          thoughts: 'I looked things over.',
          taskList: ['[x] Verify'],
          toolChoice: 'DONE',
          toolInput: 'Looks complete to me.',
        });
        if (callCount === 3) return doneResponse('Completed the requested task (retry).');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Complete task'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(callCount >= 4, 'An ambiguous verdict without "Overall: PASS" must not short-circuit as passed');
    });

    it('should not treat an audit that exhausts all iterations as passed', async () => {
      // Regression test: if the audit model keeps producing unparseable, verdict-less
      // responses for all 20 iterations (a real "confused model" failure mode observed
      // in manual testing), the loop must give up as NOT passed, not silently succeed.
      let callCount = 0;
      server.setGenerator((msgs, n) => {
        callCount++;
        if (callCount === 1) return doneResponse('Completed the requested task.');
        if (callCount >= 2 && callCount <= 21) return 'garbled nonsense with no verdict marker at all';
        if (callCount === 22) return doneResponse('Completed the requested task (retry).');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Complete task'], ctx, { timeout: 60000 });
      assert.strictEqual(result.exitCode, 0);
      assert.ok(
        callCount >= 23,
        'An audit that exhausts its iteration cap must not be accepted as passed - the main loop should retry'
      );
    });
  });

  describe('Loop Repeat Detection', () => {
    it('interrupts a model repeating the exact same tool call with no progress', async () => {
      // Regression test for a real failure mode: a struggling model re-issuing an
      // identical LIST_DIRECTORY call turn after turn instead of making progress.
      let callCount = 0;
      const repeatedCall: MockResponse = {
        thoughts: 'Exploring the backend directory.',
        taskList: ['[~] Explore backend'],
        toolChoice: 'LIST_DIRECTORY',
        toolInput: '"backend/cmd"',
      };
      server.setGenerator((msgs, n) => {
        callCount++;
        if (callCount <= 3) return repeatedCall;
        if (callCount === 4) return doneResponse('Recognized the loop and stopped.');
        return auditPassResponse();
      });

      const result = await runCLI(['-p', 'Explore the backend'], ctx, { timeout: 60000 });
      assert.strictEqual(result.exitCode, 0, `CLI should exit cleanly:\n${result.stdout}\n${result.stderr}`);

      // The 4th request (the one right after the 3rd identical call) must carry the
      // interrupt warning, proving the loop broke the pattern instead of executing
      // the identical call a 4th time.
      const fourthCallMessages = server.requests[3] || [];
      const sawWarning = fourthCallMessages.some((m: any) =>
        typeof m.content === 'string' && m.content.includes('exact same tool with the exact same input')
      );
      assert.ok(sawWarning, 'The 4th request should include the repeat-interrupt warning');
    });
  });
});
