import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeTool, setRegistry, runGuardedCommand, type ToolContext } from '../dist/tools/index.js';
import { createRegistry } from '../dist/tools/registry.js';
import { buildDefaultRegistry } from '../dist/tools/adapters.js';
import type { ToolAdapter } from '../dist/tools/adapter.js';
import type { ToolName } from '../dist/parser/markdown.js';
import type { GuardConfig } from '../dist/tools/index.js';

// Restore the default registry after each test so guarded-registry mutations
// (setRegistry) do not leak between tests.
afterEach(() => {
  setRegistry(buildDefaultRegistry());
});

const benignGuard: GuardConfig = { commandGuardEnabled: true, riskThreshold: 100 };
const backstopGuard: GuardConfig = { commandGuardEnabled: true, riskThreshold: 0 };

describe('runGuardedCommand', () => {
  it('executes a benign command when the classifier is off and risk is low', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'guard-run-'));
    try {
      const out = await runGuardedCommand('echo hi-from-guard', cwd, benignGuard);
      assert.ok(out.includes('hi-from-guard'), `Expected the command output, got: ${out}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('blocks deterministically via the risk backstop without executing', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'guard-block-'));
    const decoy = join(cwd, 'must-survive.txt');
    writeFileSync(decoy, 'do not delete');
    try {
      const out = await runGuardedCommand(`rm -rf ${decoy}`, cwd, backstopGuard);
      assert.match(out, /blocked by safety guard/, 'Should report the command was blocked');
      assert.ok(existsSync(decoy), 'The command must NOT have executed - the file must survive');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

// A minimal enterprise custom tool that opts into the classifier by setting
// classify: true and routing command execution through the shared helper.
const guardedCustomTool = (name: string): ToolAdapter => ({
  classify: true,
  metadata: {
    name,
    label: name,
    description: 'Runs a command through the command classifier.',
    capabilities: ['execute'],
    mutates: true,
  },
  execute: async ({ input, ctx }) => {
    const guard = ctx.guard ?? { commandGuardEnabled: true };
    return runGuardedCommand(input.trim(), ctx.cwd, guard);
  },
});

describe('Enterprise custom tool - classifier option', () => {
  it('runs a benign command through a classified custom tool', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'guard-custom-'));
    setRegistry(createRegistry().register(guardedCustomTool('CUSTOM_RUN')));
    const ctx: ToolContext = { cwd, automated: true, guard: benignGuard };
    try {
      const out = await executeTool('CUSTOM_RUN' as ToolName, 'echo custom-ok', ctx);
      assert.ok(out.includes('custom-ok'), `Expected command output, got: ${out}`);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('declines/blocks a catastrophic command in a classified custom tool without executing it', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'guard-custom-block-'));
    const decoy = join(cwd, 'must-survive.txt');
    writeFileSync(decoy, 'do not delete');
    setRegistry(createRegistry().register(guardedCustomTool('CUSTOM_RUN')));
    const ctx: ToolContext = { cwd, automated: true, guard: backstopGuard };
    try {
      const out = await executeTool('CUSTOM_RUN' as ToolName, `rm -rf ${decoy}`, ctx);
      assert.match(out, /blocked by safety guard|declined/i, 'Should report the command was refused');
      assert.ok(existsSync(decoy), 'The catastrophic command must NOT have executed');
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
