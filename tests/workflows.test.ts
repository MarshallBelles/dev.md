import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { MockAPIServer, doneResponse, auditPassResponse, MockResponse } from './mock-server.js';
import { createTestContext, runCLI, readTestFile, writeTestFile, testFileExists, getSessionFile, TestContext, getTestPort } from './utils.js';

const TEST_PORT = getTestPort(1); // workflows.test.ts uses port 18766

describe('Multi-Step Workflow Tests', () => {
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

  describe('Create Project Workflow', () => {
    it('should create a complete project structure', async () => {
      const steps: (MockResponse | string)[] = [
        {
          thoughts: 'Starting to create project structure. First, I\'ll create the source directory.',
          taskList: ['[~] Create src directory', '[ ] Create index.ts', '[ ] Create package.json'],
          toolChoice: 'COMMAND',
          toolInput: 'mkdir -p src',
        },
        {
          thoughts: 'Directory created. Now creating the main entry file.',
          taskList: ['[x] Create src directory', '[~] Create index.ts', '[ ] Create package.json'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"src/index.ts"

\`\`\`ts
export const main = () => {
  console.log('Hello, World!');
};

main();
\`\`\``,
        },
        {
          thoughts: 'Entry file created. Now creating package.json.',
          taskList: ['[x] Create src directory', '[x] Create index.ts', '[~] Create package.json'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"package.json"

\`\`\`json
{
  "name": "my-project",
  "version": "1.0.0",
  "main": "src/index.ts",
  "scripts": {
    "start": "ts-node src/index.ts"
  }
}
\`\`\``,
        },
        doneResponse('Created project with src/index.ts and package.json'),
        auditPassResponse(),
      ];

      let stepIdx = 0;
      server.setGenerator(() => steps[stepIdx++] || steps[steps.length - 1]);

      const result = await runCLI(['-p', 'Create a new TypeScript project'], ctx);
      assert.strictEqual(result.exitCode, 0);

      assert.ok(testFileExists(ctx, 'src/index.ts'), 'src/index.ts should exist');
      assert.ok(testFileExists(ctx, 'package.json'), 'package.json should exist');

      const indexContent = readTestFile(ctx, 'src/index.ts');
      assert.ok(indexContent?.includes('main'), 'index.ts should have main function');

      const pkgContent = readTestFile(ctx, 'package.json');
      assert.ok(pkgContent?.includes('my-project'), 'package.json should have project name');
    });
  });

  describe('Read-Modify-Write Workflow', () => {
    it('should read a file, modify it, and write back', async () => {
      writeTestFile(ctx, 'config.ts', `export const config = {
  port: 3000,
  host: 'localhost',
  debug: false,
};`);

      const steps: (MockResponse | string)[] = [
        {
          thoughts: 'First, let me read the current config.',
          taskList: ['[~] Read config', '[ ] Modify port', '[ ] Save changes'],
          toolChoice: 'READ_FILE',
          toolInput: '"config.ts"',
        },
        {
          thoughts: 'I can see the config. Now I\'ll change the port to 8080.',
          taskList: ['[x] Read config', '[~] Modify port', '[ ] Save changes'],
          toolChoice: 'FIND_AND_REPLACE_IN_FILE',
          toolInput: `"config.ts"

\`\`\`find
port: 3000
\`\`\`

\`\`\`replace
port: 8080
\`\`\``,
        },
        {
          thoughts: 'Port updated. Let me verify the change.',
          taskList: ['[x] Read config', '[x] Modify port', '[~] Save changes'],
          toolChoice: 'READ_FILE',
          toolInput: '"config.ts"',
        },
        doneResponse('Changed port from 3000 to 8080 in config.ts'),
        auditPassResponse(),
      ];

      let stepIdx = 0;
      server.setGenerator(() => steps[stepIdx++] || steps[steps.length - 1]);

      const result = await runCLI(['-p', 'Change port to 8080'], ctx);
      assert.strictEqual(result.exitCode, 0);

      const content = readTestFile(ctx, 'config.ts');
      assert.ok(content?.includes('port: 8080'), 'Port should be 8080');
      assert.ok(!content?.includes('port: 3000'), 'Old port should be gone');
    });
  });

  describe('Explore and Analyze Workflow', () => {
    it('should explore codebase and gather information', async () => {
      writeTestFile(ctx, 'src/api/users.ts', 'export const getUsers = () => [];');
      writeTestFile(ctx, 'src/api/posts.ts', 'export const getPosts = () => [];');
      writeTestFile(ctx, 'src/utils/helpers.ts', 'export const helper = () => {};');
      writeTestFile(ctx, 'src/index.ts', 'import "./api/users";');

      const steps: (MockResponse | string)[] = [
        {
          thoughts: 'Let me explore the project structure first.',
          taskList: ['[~] List project structure', '[ ] Analyze API files', '[ ] Summarize'],
          toolChoice: 'LIST_DIRECTORY',
          toolInput: '"src/**/*.ts"',
        },
        {
          thoughts: 'Found the structure. Let me read the API files.',
          taskList: ['[x] List project structure', '[~] Analyze API files', '[ ] Summarize'],
          toolChoice: 'READ_FILE',
          toolInput: '"src/api/users.ts"',
        },
        {
          thoughts: 'Got users API. Checking posts API.',
          taskList: ['[x] List project structure', '[~] Analyze API files', '[ ] Summarize'],
          toolChoice: 'READ_FILE',
          toolInput: '"src/api/posts.ts"',
        },
        doneResponse('Analyzed project: Found 2 API endpoints (users, posts) and utility helpers.'),
        auditPassResponse(),
      ];

      let stepIdx = 0;
      server.setGenerator(() => steps[stepIdx++] || steps[steps.length - 1]);

      const result = await runCLI(['-p', 'Analyze the project structure'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(result.stdout.includes('users') || result.stdout.includes('API'), 'Should mention findings');
    });
  });

  describe('Build and Test Workflow', () => {
    it('should run build commands and handle output', async () => {
      writeTestFile(ctx, 'package.json', '{"scripts":{"build":"echo BUILD_OK","test":"echo TEST_OK"}}');

      const steps: (MockResponse | string)[] = [
        {
          thoughts: 'Running the build command.',
          taskList: ['[~] Run build', '[ ] Run tests', '[ ] Verify'],
          toolChoice: 'COMMAND',
          toolInput: 'npm run build 2>&1 || echo "build script placeholder"',
        },
        {
          thoughts: 'Build completed. Now running tests.',
          taskList: ['[x] Run build', '[~] Run tests', '[ ] Verify'],
          toolChoice: 'COMMAND',
          toolInput: 'npm run test 2>&1 || echo "test script placeholder"',
        },
        doneResponse('Build and tests completed successfully'),
        auditPassResponse(),
      ];

      let stepIdx = 0;
      server.setGenerator(() => steps[stepIdx++] || steps[steps.length - 1]);

      const result = await runCLI(['-p', 'Build and test the project'], ctx, { timeout: 60000 });
      assert.strictEqual(result.exitCode, 0);
    });
  });

  describe('Error Recovery Workflow', () => {
    it('should handle errors and retry', async () => {
      const steps: (MockResponse | string)[] = [
        {
          thoughts: 'Attempting to read a file.',
          taskList: ['[~] Read file'],
          toolChoice: 'READ_FILE',
          toolInput: '"missing.txt"',
        },
        {
          thoughts: 'File not found. I\'ll create it instead.',
          taskList: ['[x] Read file (not found)', '[~] Create file'],
          toolChoice: 'WRITE_FILE',
          toolInput: `"missing.txt"

\`\`\`txt
Created this file since it was missing
\`\`\``,
        },
        doneResponse('Created missing.txt after initial read failed'),
        auditPassResponse(),
      ];

      let stepIdx = 0;
      server.setGenerator(() => steps[stepIdx++] || steps[steps.length - 1]);

      const result = await runCLI(['-p', 'Read or create missing.txt'], ctx);
      assert.strictEqual(result.exitCode, 0);
      assert.ok(testFileExists(ctx, 'missing.txt'), 'File should be created');
    });
  });

  describe('Task List Tracking', () => {
    it('should maintain task list state across steps', async () => {
      const steps: (MockResponse | string)[] = [
        {
          thoughts: 'Planning out the work.',
          taskList: ['[~] Plan', '[ ] Execute', '[ ] Verify'],
          toolChoice: 'UPDATE_TASK_LIST',
          toolInput: '',
        },
        {
          thoughts: 'Executing the main task.',
          taskList: ['[x] Plan', '[~] Execute', '[ ] Verify'],
          toolChoice: 'COMMAND',
          toolInput: 'echo "executing"',
        },
        {
          thoughts: 'Verifying the work.',
          taskList: ['[x] Plan', '[x] Execute', '[~] Verify'],
          toolChoice: 'LIST_DIRECTORY',
          toolInput: '"."',
        },
        doneResponse('All tasks completed: Plan, Execute, Verify'),
        auditPassResponse(),
      ];

      let stepIdx = 0;
      server.setGenerator(() => steps[stepIdx++] || steps[steps.length - 1]);

      const result = await runCLI(['-p', 'Execute workflow'], ctx);
      assert.strictEqual(result.exitCode, 0);

      const session = getSessionFile(ctx, result.sessionId!);
      assert.ok(session, 'Session should exist');
      assert.ok(session.taskList.length > 0, 'Task list should be populated');
    });
  });

  describe('Complex File Operations', () => {
    it('should handle multiple file modifications', async () => {
      writeTestFile(ctx, 'src/a.ts', 'export const A = "a";');
      writeTestFile(ctx, 'src/b.ts', 'export const B = "b";');
      writeTestFile(ctx, 'src/index.ts', 'import { A } from "./a";\nimport { B } from "./b";\nconsole.log(A, B);');

      const steps: (MockResponse | string)[] = [
        {
          thoughts: 'Updating A constant.',
          taskList: ['[~] Update A', '[ ] Update B', '[ ] Verify index'],
          toolChoice: 'FIND_AND_REPLACE_IN_FILE',
          toolInput: `"src/a.ts"

\`\`\`find
"a"
\`\`\`

\`\`\`replace
"alpha"
\`\`\``,
        },
        {
          thoughts: 'Updating B constant.',
          taskList: ['[x] Update A', '[~] Update B', '[ ] Verify index'],
          toolChoice: 'FIND_AND_REPLACE_IN_FILE',
          toolInput: `"src/b.ts"

\`\`\`find
"b"
\`\`\`

\`\`\`replace
"beta"
\`\`\``,
        },
        {
          thoughts: 'Verifying index.ts imports.',
          taskList: ['[x] Update A', '[x] Update B', '[~] Verify index'],
          toolChoice: 'READ_FILE',
          toolInput: '"src/index.ts"',
        },
        doneResponse('Updated A to "alpha" and B to "beta"'),
        auditPassResponse(),
      ];

      let stepIdx = 0;
      server.setGenerator(() => steps[stepIdx++] || steps[steps.length - 1]);

      const result = await runCLI(['-p', 'Update constants'], ctx);
      assert.strictEqual(result.exitCode, 0);

      assert.ok(readTestFile(ctx, 'src/a.ts')?.includes('alpha'), 'A should be alpha');
      assert.ok(readTestFile(ctx, 'src/b.ts')?.includes('beta'), 'B should be beta');
    });
  });
});
