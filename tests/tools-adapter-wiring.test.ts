import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeTool, getRegistry, setRegistry } from '../dist/tools/index.js';
import { createRegistry } from '../dist/tools/registry.js';
import type { ToolAdapter } from '../dist/tools/adapter.js';

const tempDir = mkdtempSync(join(tmpdir(), 'dev-md-wire-'));

after(() => { rmSync(tempDir, { recursive: true, force: true }); });

describe('executeTool wiring (Phase 1c)', () => {
  it('writes a file through the WRITE_FILE adapter and reads it back', async () => {
    const written = await executeTool('WRITE_FILE', `"note.txt"\n\n\`\`\`txt\nhi there\n\`\`\``, { cwd: tempDir, automated: true });
    assert.ok(written.startsWith('File written'), `unexpected: ${written}`);
    assert.strictEqual(readFileSync(join(tempDir, 'note.txt'), 'utf-8'), 'hi there');

    const read = await executeTool('READ_FILE', '"note.txt"', { cwd: tempDir, automated: true });
    assert.strictEqual(read, 'hi there');
  });

  it('reports a missing file for READ_FILE', async () => {
    const out = await executeTool('READ_FILE', '"nope.txt"', { cwd: tempDir, automated: true });
    assert.match(out, /File not found/);
  });

  it('runs a shell command through the COMMAND adapter', async () => {
    const out = await executeTool('COMMAND', 'echo wired-works', { cwd: tempDir, automated: true });
    assert.ok(out.includes('wired-works'), `unexpected: ${out}`);
  });

  it('routes control tools through their adapters', async () => {
    assert.strictEqual(await executeTool('UPDATE_TASK_LIST', '', { cwd: tempDir, automated: true }), 'Task list updated');
    assert.strictEqual(await executeTool('DONE', 'all done', { cwd: tempDir, automated: true }), 'all done');
  });

  it('returns "Unknown tool" for an unregistered name', async () => {
    const out = await executeTool('NO_SUCH_TOOL' as any, '{}', { cwd: tempDir, automated: true });
    assert.strictEqual(out, 'Unknown tool: NO_SUCH_TOOL');
  });
});

describe('registry wiring (Phase 1c)', () => {
  it('exposes built-in tools with correct metadata and capability tags', () => {
    const reg = getRegistry();
    for (const name of ['READ_FILE', 'LIST_DIRECTORY', 'WRITE_FILE', 'FIND_AND_REPLACE_IN_FILE', 'COMMAND', 'UPDATE_TASK_LIST', 'ASK_USER', 'DONE', 'READ_BACKGROUND_PROCESS', 'LIST_BACKGROUND_PROCESSES', 'KILL_BACKGROUND_PROCESS', 'READ_MORE_OUTPUT']) {
      assert.ok(reg.has(name), `expected ${name} to be registered`);
    }
    assert.strictEqual(reg.size, 12);

    const write = reg.get('WRITE_FILE')!;
    assert.strictEqual(write.metadata.mutates, true);
    assert.ok(write.metadata.capabilities.includes('write'));

    const read = reg.get('READ_FILE')!;
    assert.strictEqual(read.metadata.mutates, false);
    assert.ok(read.metadata.capabilities.includes('read'));
  });

  it('filters tools by capability (what governance/surfaces rely on)', () => {
    const reg = getRegistry();
    const writeTools = reg.listByCapability('write').map(a => a.metadata.name);
    assert.ok(writeTools.includes('WRITE_FILE'));
    assert.ok(!writeTools.includes('READ_FILE'));

    const mutates = reg.list().filter(a => a.metadata.mutates).map(a => a.metadata.name);
    assert.ok(mutates.includes('COMMAND'));
    assert.ok(mutates.includes('WRITE_FILE'));
  });

  it('lets setRegistry() swap the active registry', async () => {
    const original = getRegistry();
    try {
      const custom = createRegistry();
      const echo: ToolAdapter = {
        metadata: { name: 'ECHO', label: 'Echo', description: 'echoes input', capabilities: [], mutates: false },
        execute: async ({ input }) => `echoed: ${input}`,
      };
      custom.register(echo);
      setRegistry(custom);
      assert.strictEqual(getRegistry(), custom);
      assert.strictEqual(await executeTool('ECHO' as any, 'hey', { cwd: tempDir, automated: true }), 'echoed: hey');
    } finally {
      setRegistry(original);
    }
  });
});
