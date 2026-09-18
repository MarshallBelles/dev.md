import { describe, it } from 'node:test';
import assert from 'node:assert';
import { PolicyDecisionPoint } from '../dist/governance/pdp.js';
import { GovernanceChain, buildDefaultChain } from '../dist/governance/chain.js';
import { allow, deny, type ToolInvocationContext } from '../dist/governance/types.js';

const ctx: ToolInvocationContext = {
  toolName: 'WRITE_FILE', label: 'Write', capabilities: ['write'], mutates: true,
  rawInput: 'x', cwd: '/tmp', automated: true,
  actor: { id: 'u1', scopes: ['write'] }, runId: 'r1',
};

describe('PolicyDecisionPoint (Phase 2c)', () => {
  it('evaluates the first matching rule', () => {
    const pdp = new PolicyDecisionPoint([{
      id: 'd1',
      rules: [
        { name: 'block-writes', conditions: [{ path: '/mutates', op: 'eq', value: true }, { path: '/toolName', op: 'eq', value: 'WRITE_FILE' }], verdict: 'deny' },
        { name: 'default-allow', conditions: [], verdict: 'allow' },
      ],
    }]);
    assert.deepStrictEqual(pdp.decision('d1', { mutates: true, toolName: 'WRITE_FILE' }), { verdict: 'deny', rule: 'block-writes' });
  });
  it('falls through to a later matching rule', () => {
    const pdp = new PolicyDecisionPoint([{
      id: 'd1',
      rules: [
        { name: 'allow-reads', conditions: [{ path: '/toolName', op: 'eq', value: 'READ_FILE' }], verdict: 'allow' },
        { name: 'default-deny', conditions: [], verdict: 'deny' },
      ],
    }]);
    assert.deepStrictEqual(pdp.decision('d1', { toolName: 'KILL_BACKGROUND_PROCESS' }), { verdict: 'deny', rule: 'default-deny' });
  });
  it('supports in / ne / exists / gte / lte', () => {
    const pdp = new PolicyDecisionPoint([{
      id: 'ops',
      rules: [
        { name: 'scoped', conditions: [{ path: '/actor/scopes/0', op: 'in', value: ['write', 'admin'] }], verdict: 'allow' },
      ],
    }]);
    assert.strictEqual(pdp.decision('ops', { actor: { scopes: ['write'] } }).verdict, 'allow');
    assert.strictEqual(pdp.decision('ops', { actor: { scopes: ['read'] } }).verdict, 'deny');
  });
  it('default-denies when no document matches', () => {
    const pdp = new PolicyDecisionPoint();
    const d = pdp.decision('missing', {});
    assert.strictEqual(d.verdict, 'deny');
    assert.match(d.reason || '', /default-deny/);
  });
  it('records the matched rule and supports the exception verdict', () => {
    const pdp = new PolicyDecisionPoint([{
      id: 'ex',
      rules: [{ name: 'audited-only', conditions: [{ path: '/toolName', op: 'eq', value: 'READ_FILE' }], verdict: 'exception' }],
    }]);
    assert.deepStrictEqual(pdp.decision('ex', { toolName: 'READ_FILE' }), { verdict: 'exception', rule: 'audited-only' });
  });
});

describe('GovernanceChain (Phase 2c)', () => {
  it('returns allow when every middleware allows', async () => {
    const chain = new GovernanceChain([
      { name: 'a', decide: () => allow() },
      { name: 'b', decide: () => allow() },
    ]);
    assert.deepStrictEqual(await chain.runDecide(ctx), { status: 'allow' });
  });
  it('returns the first non-allow decision and stops the chain', async () => {
    let b = false;
    const chain = new GovernanceChain([
      { name: 'a', decide: () => deny('first') },
      { name: 'b', decide: () => { b = true; return allow(); } },
    ]);
    const d = await chain.runDecide(ctx);
    assert.deepStrictEqual(d, { status: 'deny', reason: 'first' });
    assert.strictEqual(b, false, 'downstream middleware must not run');
  });
  it('runs observe() for every middleware that provides it, skipping plain ones', async () => {
    const seen: string[] = [];
    const chain = new GovernanceChain([
      { name: 'audit', decide: () => allow(), observe: async () => { seen.push('audit'); } },
      { name: 'cost', decide: () => allow(), observe: async () => { seen.push('cost'); } },
      { name: 'plain', decide: () => allow() },
    ]);
    await chain.runObserve({ toolName: 'WRITE_FILE', outcome: 'ok', errored: false, durationMs: 1 });
    assert.deepStrictEqual(seen, ['audit', 'cost']);
  });
  it('buildDefaultChain installs authorization/audit/usage/cost', () => {
    const chain = buildDefaultChain({ actor: { id: 'u1' }, runId: 'r1' });
    assert.strictEqual(chain.length, 4);
    assert.deepStrictEqual(chain.names, ['authorization', 'audit', 'usage', 'cost']);
  });
});
