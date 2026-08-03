import { describe, it } from 'node:test';
import assert from 'node:assert';
import { estimateTokens } from '../dist/sessions/index.js';
import { parseResponse, extractPath, extractCodeBlock, extractFindReplace, extractCommandInput } from '../dist/parser/markdown.js';
import { isAuditAllowed } from '../dist/tools/command.js';

describe('Edge Cases', () => {
  describe('estimateTokens', () => {
    it('should estimate tokens as chars / 4', () => {
      const messages = [{ role: 'user' as const, content: 'Hello World' }];
      const tokens = estimateTokens(messages);
      assert.strictEqual(tokens, 3, '11 chars / 4 = 2.75 → 3');
    });

    it('should handle empty messages', () => {
      const messages = [{ role: 'user' as const, content: '' }];
      assert.strictEqual(estimateTokens(messages), 0);
    });

    it('should handle multiple messages', () => {
      const messages = [
        { role: 'system' as const, content: 'Welcome' },
        { role: 'user' as const, content: 'Hello' },
        { role: 'assistant' as const, content: 'Hi' }
      ];
      // 7 + 5 + 2 = 14 chars / 4 = 3.5 → 4
      assert.strictEqual(estimateTokens(messages), 4);
    });

    it('should handle long messages', () => {
      const longContent = 'a'.repeat(131072);
      const messages = [{ role: 'user' as const, content: longContent }];
      assert.strictEqual(estimateTokens(messages), Math.ceil(131072 / 4));
    });
  });

  describe('isAuditAllowed', () => {
    it('should allow cat command', () => {
      assert.ok(isAuditAllowed('cat file.txt'));
    });

    it('should allow head command', () => {
      assert.ok(isAuditAllowed('head file.txt'));
    });

    it('should allow tail command', () => {
      assert.ok(isAuditAllowed('tail file.txt'));
    });

    it('should allow ls command', () => {
      assert.ok(isAuditAllowed('ls -la'));
    });

    it('should allow git status', () => {
      assert.ok(isAuditAllowed('git status'));
    });

    it('should allow git diff', () => {
      assert.ok(isAuditAllowed('git diff HEAD'));
    });

    it('should allow git log', () => {
      assert.ok(isAuditAllowed('git log -n 3'));
    });

    it('should allow npm test', () => {
      assert.ok(isAuditAllowed('npm test'));
    });

    it('should disallow npm install', () => {
      assert.ok(!isAuditAllowed('npm install'));
    });

    it('should disallow echo', () => {
      assert.ok(!isAuditAllowed('echo hello'));
    });

    it('should disallow rm command', () => {
      assert.ok(!isAuditAllowed('rm -rf dist/'));
    });

    it('should disallow mkdir command', () => {
      assert.ok(!isAuditAllowed('mkdir -p src/'));
    });

    it('should disallow dangerous commands', () => {
      assert.ok(!isAuditAllowed('git push'));
      assert.ok(!isAuditAllowed('git checkout main'));
      assert.ok(!isAuditAllowed('npm run deploy'));
    });
  });

  describe('parseResponse edge cases', () => {
    it('should handle response without # Agent Response marker', () => {
      const result = parseResponse('Just some text');
      assert.strictEqual(result, null);
    });

    it('should handle response with only # Agent Response', () => {
      const result = parseResponse('# Agent Response');
      assert.strictEqual(result, null);
    });

    it('should handle response with empty tool input', () => {
      const response = `# Agent Response

## Thoughts
Done.

## Tool Choice
DONE

## Tool Input`;

      const result = parseResponse(response);
      assert.ok(result);
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.tools[0].toolChoice, 'DONE');
    });

    it('should handle response with only thoughts (no tools)', () => {
      const response = `# Agent Response

## Thoughts
Just thinking...`;

      const result = parseResponse(response);
      assert.strictEqual(result, null);
    });

    it('should handle multiple # Agent Response markers', () => {
      const response = `# Agent Response

## Thoughts
First thought.

## Tool Choice
COMMAND

## Tool Input
echo first

# Agent Response

## Thoughts
Second thought.

## Tool Choice
DONE

## Tool Input
Second response.`;

      const result = parseResponse(response);
      assert.ok(result);
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.tools[0].toolChoice, 'DONE');
    });

    it('should handle response with empty sections', () => {
      const response = `# Agent Response

## Thoughts

## Task List

## Tool Choice
DONE

## Tool Input`;

      const result = parseResponse(response);
      assert.ok(result);
      assert.strictEqual(result.tools.length, 1);
      assert.strictEqual(result.thoughts, '');
      assert.strictEqual(result.taskList.length, 0);
    });
  });

  describe('extractPath edge cases', () => {
    it('should handle quoted path', () => {
      assert.strictEqual(extractPath('"src/index.ts"'), 'src/index.ts');
    });

    it('should handle unquoted path', () => {
      assert.strictEqual(extractPath('src/index.ts'), 'src/index.ts');
    });

    it('should handle empty path', () => {
      assert.strictEqual(extractPath(''), '');
    });
  });

  describe('extractCodeBlock edge cases', () => {
    it('should return null for no code block', () => {
      assert.strictEqual(extractCodeBlock('just text'), null);
    });

    it('should handle empty code block', () => {
      const result = extractCodeBlock('```ts\n```');
      assert.strictEqual(result, '');
    });

    it('should handle multi-line code block', () => {
      const result = extractCodeBlock('```ts\nconst x = 1;\nconst y = 2;\n```');
      assert.ok(result);
      assert.ok(result.includes('x = 1'));
      assert.ok(result.includes('y = 2'));
    });

    it('should handle code block with language tag', () => {
      const result = extractCodeBlock('```javascript\nconsole.log("hi");\n```');
      assert.strictEqual(result, 'console.log("hi");');
    });
  });

  describe('extractFindReplace edge cases', () => {
    it('should return null for missing find block', () => {
      const result = extractFindReplace('```replace\nnew\n```');
      assert.strictEqual(result, null);
    });

    it('should return null for missing replace block', () => {
      const result = extractFindReplace('```find\nold\n```');
      assert.strictEqual(result, null);
    });
  });

  describe('extractCommandInput', () => {
    it('should extract from code block', () => {
      const result = extractCommandInput('```bash\necho hello\n```');
      assert.strictEqual(result, 'echo hello');
    });

    it('should fall back to raw input', () => {
      const result = extractCommandInput('echo hello');
      assert.strictEqual(result, 'echo hello');
    });
  });
});
