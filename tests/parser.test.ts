import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseResponse, extractCodeBlock, extractFindReplace } from '../dist/parser/markdown.js';

describe('Parser Tests', () => {
  describe('parseResponse', () => {
    it('should parse single tool response', () => {
      const response = `# Agent Response

## Thoughts
I need to list the directory.

## Task List
[~] List directory

## Tool Choice
LIST_DIRECTORY

## Tool Input
"src"`;

      const parsed = parseResponse(response);
      assert.ok(parsed);
      assert.strictEqual(parsed.tools.length, 1);
      assert.strictEqual(parsed.tools[0].toolChoice, 'LIST_DIRECTORY');
      assert.strictEqual(parsed.tools[0].toolInput, '"src"');
      // Backward compatibility
      assert.strictEqual(parsed.toolChoice, 'LIST_DIRECTORY');
      assert.strictEqual(parsed.toolInput, '"src"');
    });

    it('should parse multiple tools in one response', () => {
      const response = `# Agent Response

## Thoughts
I need to write a file and then complete.

## Task List
[x] Create file

## Tool Choice
WRITE_FILE

## Tool Input
"test.txt"

\`\`\`txt
Hello World
\`\`\`

## Tool Choice
DONE

## Tool Input
Created the file successfully.`;

      const parsed = parseResponse(response);
      assert.ok(parsed);
      assert.strictEqual(parsed.tools.length, 2);
      assert.strictEqual(parsed.tools[0].toolChoice, 'WRITE_FILE');
      assert.ok(parsed.tools[0].toolInput.includes('test.txt'));
      assert.ok(parsed.tools[0].toolInput.includes('Hello World'));
      assert.strictEqual(parsed.tools[1].toolChoice, 'DONE');
      assert.strictEqual(parsed.tools[1].toolInput, 'Created the file successfully.');
    });

    it('should ignore headers inside code blocks', () => {
      const response = `# Agent Response

## Thoughts
Writing a markdown file.

## Task List
[~] Write README

## Tool Choice
WRITE_FILE

## Tool Input
"README.md"

\`\`\`markdown
# My Project

## Installation
Run npm install

## Tool Choice
This is NOT a real tool choice, just content
\`\`\``;

      const parsed = parseResponse(response);
      assert.ok(parsed);
      assert.strictEqual(parsed.tools.length, 1);
      assert.strictEqual(parsed.tools[0].toolChoice, 'WRITE_FILE');
      assert.ok(parsed.tools[0].toolInput.includes('# My Project'));
      assert.ok(parsed.tools[0].toolInput.includes('## Installation'));
    });

    it('should handle nested code blocks in markdown files', () => {
      const response = `# Agent Response

## Thoughts
Writing markdown with code blocks.

## Task List
[~] Write docs

## Tool Choice
WRITE_FILE

## Tool Input
"docs.md"

\`\`\`\`markdown
# Docs

Here is a code example:

\`\`\`typescript
const x = 1;
\`\`\`

End of docs
\`\`\`\`

## Tool Choice
DONE

## Tool Input
Wrote the docs file.`;

      const parsed = parseResponse(response);
      assert.ok(parsed);
      assert.strictEqual(parsed.tools.length, 2);
      assert.strictEqual(parsed.tools[0].toolChoice, 'WRITE_FILE');
      assert.strictEqual(parsed.tools[1].toolChoice, 'DONE');
    });

    it('should handle README with nested bash blocks followed by second WRITE_FILE', () => {
      // This is the exact scenario that was failing - README.md with ```bash blocks inside
      const response = `# Agent Response

## Thoughts
Creating files.

## Task List
[~] Create README.md
[~] Create .gitignore

## Tool Choice
WRITE_FILE

## Tool Input
"README.md"

\`\`\`markdown
# My Project

## Installation

\`\`\`bash
npm install
\`\`\`

## Usage

\`\`\`bash
npm start
\`\`\`
\`\`\`

## Tool Choice
WRITE_FILE

## Tool Input
".gitignore"

\`\`\`
node_modules/
dist/
\`\`\``;

      const parsed = parseResponse(response);
      assert.ok(parsed);
      assert.strictEqual(parsed.tools.length, 2, `Expected 2 tools but got ${parsed.tools.length}`);
      assert.strictEqual(parsed.tools[0].toolChoice, 'WRITE_FILE');
      assert.ok(parsed.tools[0].toolInput.includes('README.md'));
      assert.strictEqual(parsed.tools[1].toolChoice, 'WRITE_FILE');
      assert.ok(parsed.tools[1].toolInput.includes('.gitignore'));
    });
  });

  describe('extractCodeBlock', () => {
    it('should extract simple code block', () => {
      const input = `"file.txt"

\`\`\`txt
Hello World
\`\`\``;

      const block = extractCodeBlock(input);
      assert.strictEqual(block, 'Hello World');
    });

    it('should extract last closing fence for nested blocks', () => {
      const input = `"docs.md"

\`\`\`markdown
# Title

\`\`\`js
console.log("hi");
\`\`\`

End
\`\`\``;

      const block = extractCodeBlock(input);
      assert.ok(block);
      assert.ok(block.includes('# Title'));
      assert.ok(block.includes('console.log'));
      assert.ok(block.includes('End'));
    });

    it('should handle 4-backtick fences', () => {
      const input = `"file.md"

\`\`\`\`markdown
# Title

\`\`\`
nested
\`\`\`

End
\`\`\`\``;

      const block = extractCodeBlock(input);
      assert.ok(block);
      assert.ok(block.includes('# Title'));
      assert.ok(block.includes('nested'));
      assert.ok(block.includes('End'));
    });
  });

  describe('extractFindReplace', () => {
    it('should extract find and replace blocks', () => {
      const input = `"file.ts"

\`\`\`find
const old = 1;
\`\`\`

\`\`\`replace
const new = 2;
\`\`\``;

      const result = extractFindReplace(input);
      assert.ok(result);
      assert.strictEqual(result.find, 'const old = 1;');
      assert.strictEqual(result.replace, 'const new = 2;');
    });
  });
});
