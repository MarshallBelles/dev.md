import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRegistry, type ToolRegistry } from '../dist/tools/registry.js';
import type { ToolAdapter, ToolInvocation } from '../dist/tools/adapter.js';
import { makeGovernedRegistry } from '../dist/governance/governed-registry.js';
import { GovernanceChain } from '../dist/governance/chain.js';
import { allow, deny } from '../dist/governance/types.js';
import type { ToolInvocationContext } from '../dist/governance/types.js';

const makeSource = () => {
  const state = { calls: 0 };
  const spy: ToolAdapter = {
    metadata: { name: 'SPY', label: 'Spy', description: 'spy', capabilities: ['control'], mutates: false },
    execute: async (): Promise<string> => { state.calls++; return 'ran'; },
  };
  const registry = createRegistry();
  registry.register(spy);
  return { registry, state };
};

const inv: ToolInvocation = { input: '{}', ctx: { cwd: '/tmp', automated: true } };
const ctx: ToolInvocationContext = {
  toolName: 'SPY', label: 'Spy', capabilities: ['control'], mutates: false,
  rawInput: '{}', cwd: '/tmp', automated: true,
  actor: { id: 'u1', scopes: ['control'] }, runId: 'r1',
};

describe('makeGovernedRegistry (Phase 2c)', () => {
  it('executes the adapter when the chain allows and records an observation', async () => {
    const { registry, state } = makeSource();
    let observed: { toolName: string; errored: boolean } | null = null;
    const chain = new GovernanceChain([
      { name: 'auth', decide: () => allow() },
      { name: 'audit', decide: () => allow(), observe: async (r) => { observed = { toolName: r.toolName, errored: r.errored }; } },
    ]);
    const governed = makeGovernedRegistry({ source: registry, chain, actor: { id: 'u1' }, runId: 'r1' });
    const out = await governed.get('SPY')!.execute(inv);
    assert.strictEqual(out, 'ran');
    assert.strictEqual(state.calls, 1, 'adapter should run when allowed');
    assert.ok(observed);
    const rec: { toolName: string; errored: boolean } = observed as { toolName: string; errored: boolean };
    assert.strictEqual(rec.toolName, 'SPY');
    assert.strictEqual(rec.errored, false);
  });

  it('never executes the adapter when the chain denies (fail closed)', async () => {
    const { registry, state } = makeSource();
    const chain = new GovernanceChain([{ name: 'auth', decide: () => deny('nope') }]);
    const governed = makeGovernedRegistry({ source: registry, chain, actor: { id: 'u1' }, runId: 'r1' });
    const out = await governed.get('SPY')!.execute(inv);
    assert.strictEqual(state.calls, 0, 'adapter must NOT run when denied');
    assert.match(out, /denied by governance/);
  });

  it('flags the observation errored when the tool returns ERROR:', async () => {
    const spyState = { calls: 0 };
    const spy: ToolAdapter = {
      metadata: { name: 'SPY', label: 'Spy', description: 'spy', capabilities: ['control'], mutates: false },
      execute: async (): Promise<string> => { spyState.calls++; return 'ERROR: boom'; },
    };
    const registry = createRegistry();
    registry.register(spy);
    const seen: boolean[] = [];
    const chain = new GovernanceChain([
      { name: 'auth', decide: () => allow() },
      { name: 'audit', decide: () => allow(), observe: async (r) => { seen.push(r.errored); } },
    ]);
    const governed = makeGovernedRegistry({ source: registry, chain, actor: { id: 'u1' }, runId: 'r1' });
    const out = await governed.get('SPY')!.execute(inv);
    assert.strictEqual(out, 'ERROR: boom');
    assert.strictEqual(spyState.calls, 1);
    assert.deepStrictEqual(seen, [true]);
  });
});
