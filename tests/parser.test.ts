import { describe, it } from 'node:test';
import assert from 'node:assert';
import { parseResponse, extractCodeBlock, extractFindReplace, extractDelegateInput, extractPath } from '../dist/parser/markdown.js';

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

    it('should not let an unbalanced code fence in Thoughts swallow subsequent headers', () => {
      // Regression test: a real model was observed including an illustrative,
      // unclosed code snippet in its Thoughts prose. That left the parser's fence
      // tracker stuck "inside a code block," which caused every following header
      // (Task List, Tool Choice, Tool Input) to be silently absorbed as thoughts
      // text instead of recognized - producing a false "parse failure" on an
      // otherwise well-formed, complete response.
      const response = `# Agent Response

## Thoughts
I need to verify the fix works. Something like:
\`\`\`go
func Add(a, b int) int {
    return a + b
}
This should be correct based on the spec.

## Task List
[x] Review implementation

## Tool Choice
DONE

## Tool Input
Verified the implementation is correct.
`;

      const parsed = parseResponse(response);
      assert.ok(parsed, 'A response with an unbalanced fence in Thoughts must still parse');
      assert.strictEqual(parsed.tools.length, 1);
      assert.strictEqual(parsed.tools[0].toolChoice, 'DONE');
      assert.strictEqual(parsed.tools[0].toolInput, 'Verified the implementation is correct.');
      assert.strictEqual(parsed.taskList.length, 1);
      assert.strictEqual(parsed.taskList[0].status, 'complete');
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

    it('should recognize DELEGATE as a valid tool choice', () => {
      const response = `# Agent Response

## Thoughts
Delegating this to a subagent.

## Task List
[~] Delegate research task

## Tool Choice
DELEGATE

## Tool Input
"researcher"

\`\`\`
Summarize what specs/001_implementation_plan.md says about auth.
\`\`\``;

      const parsed = parseResponse(response);
      assert.ok(parsed);
      assert.strictEqual(parsed.tools[0].toolChoice, 'DELEGATE');
    });
  });

  describe('extractDelegateInput', () => {
    it('should extract the label and task body', () => {
      const input = `"researcher"

\`\`\`
Please implement the login endpoint.
\`\`\``;

      const result = extractDelegateInput(input);
      assert.ok(result);
      assert.strictEqual(result.label, 'researcher');
      assert.strictEqual(result.task, 'Please implement the login endpoint.');
    });

    it('should extract a multi-line task body', () => {
      const input = `"implementer"

\`\`\`
Implement the login endpoint.
Follow the spec in specs/003_player_auth.md.
\`\`\``;

      const result = extractDelegateInput(input);
      assert.ok(result);
      assert.strictEqual(result.label, 'implementer');
      assert.strictEqual(result.task, 'Implement the login endpoint.\nFollow the spec in specs/003_player_auth.md.');
    });

    it('should return null when the code block is missing', () => {
      const input = `"researcher"

Please implement the login endpoint.`;

      const result = extractDelegateInput(input);
      assert.strictEqual(result, null);
    });

    it('should return null when the label line is empty', () => {
      const input = `
\`\`\`
Please implement the login endpoint.
\`\`\``;

      const result = extractDelegateInput(input);
      assert.strictEqual(result, null);
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

  describe('extractPath', () => {
    it('extracts a well-formed quoted path', () => {
      assert.strictEqual(extractPath('"src/index.ts"'), 'src/index.ts');
    });

    it('falls back to an unquoted path as-is', () => {
      assert.strictEqual(extractPath('src/index.ts'), 'src/index.ts');
    });

    it('regression: strips a stray leading quote when the closing quote is missing', () => {
      // A real model was observed producing "docs/SDD.md (no closing quote). The old
      // fallback captured the whole line INCLUDING the leading quote character, which
      // then got baked into every path lookup ("/project/"docs/SDD.md), permanently
      // breaking that file/directory for the rest of the run.
      assert.strictEqual(extractPath('"docs/SDD.md'), 'docs/SDD.md');
      assert.strictEqual(extractPath('"backend/cmd'), 'backend/cmd');
      assert.strictEqual(extractPath('"backend/Makefile'), 'backend/Makefile');
    });

    it('strips a stray trailing quote when the opening quote is missing', () => {
      assert.strictEqual(extractPath('docs/SDD.md"'), 'docs/SDD.md');
    });

    it('only reads the first line and ignores the rest', () => {
      assert.strictEqual(extractPath('"backend/cmd\n\nsome other content'), 'backend/cmd');
    });
  });
});
