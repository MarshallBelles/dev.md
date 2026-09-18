import { describe, it } from 'node:test';
import assert from 'node:assert';
import { hasCapability, toolsWithCapability } from '../dist/tools/adapter.js';
import type { ToolAdapter, ToolMetadata, ToolCapability } from '../dist/tools/adapter.js';

const fullMetadata: ToolMetadata = {
  name: 'WRITE_FILE',
  label: 'Write File',
  description: 'Create or overwrite a file with the given content.',
  capabilities: ['read', 'write', 'search', 'execute', 'delegate', 'interactive', 'process', 'control'],
  mutates: true,
  inputHint: 'A quoted path plus a fenced code block with the file content.',
};

const makeAdapter = (metadata: ToolMetadata): ToolAdapter => ({
  metadata,
  execute: async () => '',
});

describe('ToolAdapter contract', () => {
  it('round-trips every field of a full ToolMetadata object', () => {
    assert.strictEqual(fullMetadata.name, 'WRITE_FILE');
    assert.strictEqual(fullMetadata.label, 'Write File');
    assert.strictEqual(fullMetadata.description, 'Create or overwrite a file with the given content.');
    assert.strictEqual(fullMetadata.mutates, true);
    assert.strictEqual(fullMetadata.inputHint, 'A quoted path plus a fenced code block with the file content.');
    assert.deepStrictEqual(fullMetadata.capabilities, ['read', 'write', 'search', 'execute', 'delegate', 'interactive', 'process', 'control']);
  });

  it('reports true for a declared capability and false for an undeclared one', () => {
    const adapter = makeAdapter(fullMetadata);
    assert.strictEqual(hasCapability(adapter, 'write'), true);
    assert.strictEqual(hasCapability(adapter, 'read'), true);
    assert.strictEqual(hasCapability(adapter, 'execute'), true);

    // An adapter that only declares 'write' must report the others as absent.
    const writeOnly = makeAdapter({ ...fullMetadata, capabilities: ['write'] });
    assert.strictEqual(hasCapability(writeOnly, 'write'), true);
    assert.strictEqual(hasCapability(writeOnly, 'read'), false);
    assert.strictEqual(hasCapability(writeOnly, 'execute'), false);
    assert.strictEqual(hasCapability(writeOnly, 'delegate'), false);
  });

  it('returns only matching names in iteration order, and [] for an empty list', () => {
    const a = makeAdapter({ ...fullMetadata, name: 'READ_FILE', capabilities: ['read'] });
    const b = makeAdapter({ ...fullMetadata, name: 'WRITE_FILE', capabilities: ['write'] });
    const c = makeAdapter({ ...fullMetadata, name: 'COMMAND', capabilities: ['execute', 'write'] });

    const adapters: ToolAdapter[] = [a, b, c];

    assert.deepStrictEqual(toolsWithCapability(adapters, 'read'), ['READ_FILE']);
    assert.deepStrictEqual(toolsWithCapability(adapters, 'write'), ['WRITE_FILE', 'COMMAND']);
    assert.deepStrictEqual(toolsWithCapability(adapters, 'execute'), ['COMMAND']);
    assert.deepStrictEqual(toolsWithCapability(adapters, 'delegate'), []);
    assert.deepStrictEqual(toolsWithCapability(adapters, 'read'), ['READ_FILE']);
    assert.deepStrictEqual(toolsWithCapability([], 'read'), []);
  });

  it('exposes a controllable execute() that resolves to a string and a known name', async () => {
    const payload = 'result-payload-42';
    const adapter: ToolAdapter = {
      metadata: {
        name: 'READ_FILE',
        label: 'Read File',
        description: 'Read a file from disk.',
        capabilities: ['read'],
        mutates: false,
      },
      execute: async (invocation) => {
        assert.ok(typeof invocation.input === 'string');
        return payload;
      },
    };

    const result = await adapter.execute({ input: '"hello.txt"', ctx: { cwd: '/tmp', automated: false } });
    assert.strictEqual(result, payload);
    assert.strictEqual(adapter.metadata.name, 'READ_FILE');
  });

  it('treats an empty capabilities array as declaring no capability', () => {
    const unknown: ToolAdapter = {
      metadata: {
        name: 'UNKNOWN_TOOL',
        label: 'Unknown Tool',
        description: 'A tool that declares no capabilities.',
        capabilities: [],
        mutates: false,
      },
      execute: async () => '',
    };

    for (const cap of ['read', 'write', 'execute', 'search', 'delegate', 'interactive', 'process', 'control'] as ToolCapability[]) {
      assert.strictEqual(hasCapability(unknown, cap), false);
    }
    assert.deepStrictEqual(toolsWithCapability([unknown], 'read'), []);
  });
});
