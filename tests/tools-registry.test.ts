import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ToolRegistry, createRegistry } from '../dist/tools/registry.js';
import type { ToolAdapter, ToolMetadata, ToolCapability } from '../dist/tools/adapter.js';

const baseMetadata: ToolMetadata = {
  name: 'BASE',
  label: 'Base Tool',
  description: 'A test adapter used to populate a registry.',
  capabilities: [],
  mutates: false,
};

/** A plain ToolAdapter built from metadata, with a controllable mocked execute(). */
const makeAdapter = (
  overrides: Partial<ToolMetadata> & { name?: string; capabilities?: ToolCapability[] } = {},
): ToolAdapter => ({
  metadata: { ...baseMetadata, ...overrides },
  execute: async () => '',
});

describe('ToolRegistry', () => {
  it('createRegistry() yields an empty registry: size 0 and list() is []', () => {
    const registry = createRegistry();
    assert.strictEqual(registry.size, 0);
    assert.deepStrictEqual(registry.list(), []);
  });

  it('register() stores the adapter; get() returns the same instance; has() becomes true', () => {
    const registry = createRegistry();
    const adapter = makeAdapter({ name: 'READ_FILE', capabilities: ['read'] });

    const returned = registry.register(adapter);

    assert.strictEqual(registry.get('READ_FILE'), adapter);
    assert.strictEqual(registry.has('READ_FILE'), true);
    assert.strictEqual(registry.size, 1);
    assert.notStrictEqual(registry.get('WRITE_FILE'), adapter);
    assert.strictEqual(registry.has('WRITE_FILE'), false);
    void returned;
  });

  it('register() returns `this` for chaining and records each adapter', () => {
    const registry = createRegistry();
    const a = makeAdapter({ name: 'A', capabilities: ['read'] });
    const b = makeAdapter({ name: 'B', capabilities: ['write'] });

    const chained = a && registry.register(a) && registry.register(b);

    assert.strictEqual(chained, registry);
    assert.strictEqual(registry.get('A'), a);
    assert.strictEqual(registry.get('B'), b);
    assert.strictEqual(registry.size, 2);
  });

  it('register() throws when the name is already taken', () => {
    const registry = createRegistry();
    registry.register(makeAdapter({ name: 'DUP', capabilities: ['read'] }));

    assert.throws(
      () => registry.register(makeAdapter({ name: 'DUP', capabilities: ['write'] })),
      /Tool already registered: DUP/,
    );
    // A name collision by name must not shadow the previously stored adapter.
    assert.strictEqual(registry.get('DUP')?.metadata.label, 'Base Tool');
  });

  it('list() returns all adapters in insertion order', () => {
    const registry = createRegistry();
    const first = makeAdapter({ name: 'FIRST', capabilities: ['read'] });
    const second = makeAdapter({ name: 'SECOND', capabilities: ['write'] });
    const third = makeAdapter({ name: 'THIRD', capabilities: ['execute'] });

    registry.register(first).register(second).register(third);

    assert.deepStrictEqual(
      registry.list().map((a) => a.metadata.name),
      ['FIRST', 'SECOND', 'THIRD'],
    );
  });

  it('listByCapability() returns only matching adapters in insertion order, and [] when none match', () => {
    const registry = createRegistry();
    const readWrite = makeAdapter({ name: 'RW', capabilities: ['read', 'write'] });
    const execOnly = makeAdapter({ name: 'EXEC', capabilities: ['execute'] });
    const readOnly = makeAdapter({ name: 'RD', capabilities: ['read'] });

    registry.register(readWrite).register(execOnly).register(readOnly);

    assert.deepStrictEqual(registry.listByCapability('write').map((a) => a.metadata.name), ['RW']);
    assert.deepStrictEqual(registry.listByCapability('read').map((a) => a.metadata.name), ['RW', 'RD']);
    assert.deepStrictEqual(registry.listByCapability('execute').map((a) => a.metadata.name), ['EXEC']);

    const empty = createRegistry();
    assert.deepStrictEqual(empty.listByCapability('delegate'), []);
  });

  it('get() returns undefined for an unknown name', () => {
    const registry = createRegistry();
    registry.register(makeAdapter({ name: 'KNOWN', capabilities: ['read'] }));
    assert.strictEqual(registry.get('MISSING'), undefined);
  });
});
