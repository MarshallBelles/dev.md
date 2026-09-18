import { describe, it } from 'node:test';
import assert from 'node:assert';
import { allow, deny, approve, failError, isDenial, isBlocked, needsApproval, makeAuditRecord, makeUsageRecord } from '../dist/governance/types.js';

describe('governance decisions (Phase 2a)', () => {
  it('allow() yields a bare allow', () => {
    assert.deepStrictEqual(allow(), { status: 'allow' });
  });
  it('deny() carries the reason and is flagged deny/blocked', () => {
    const d = deny('nope');
    assert.deepStrictEqual(d, { status: 'deny', reason: 'nope' });
    assert.strictEqual(isDenial(d), true);
    assert.strictEqual(isBlocked(d), true);
    assert.strictEqual(needsApproval(d), false);
  });
  it('approve() is optional-reason and needs approval without blocking', () => {
    assert.deepStrictEqual(approve(), { status: 'approve' });
    assert.deepStrictEqual(approve('please'), { status: 'approve', reason: 'please' });
    assert.strictEqual(needsApproval(approve('x')), true);
    assert.strictEqual(isBlocked(approve('x')), false);
    assert.strictEqual(isDenial(approve('x')), false);
  });
  it('failError() blocks and records a reason but is not a pure denial', () => {
    const d = failError('boom');
    assert.deepStrictEqual(d, { status: 'error', reason: 'boom' });
    assert.strictEqual(isBlocked(d), true);
    assert.strictEqual(isDenial(d), false);
    assert.strictEqual(needsApproval(d), false);
  });
  it('guard truth table for allow', () => {
    const a = allow();
    assert.strictEqual(isBlocked(a), false);
    assert.strictEqual(isDenial(a), false);
    assert.strictEqual(needsApproval(a), false);
  });
});

describe('governance records (Phase 2a)', () => {
  it('makeAuditRecord fills sensible defaults', () => {
    const r = makeAuditRecord({ runId: 'r1', actorId: 'u1', toolName: 'WRITE_FILE' });
    assert.strictEqual(r.runId, 'r1');
    assert.strictEqual(r.actorId, 'u1');
    assert.strictEqual(r.toolName, 'WRITE_FILE');
    assert.strictEqual(r.decision, 'allow');
    assert.strictEqual(r.errored, false);
    assert.strictEqual(typeof r.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(r.timestamp)));
  });
  it('makeAuditRecord honours overrides', () => {
    const r = makeAuditRecord({ runId: 'r2', actorId: 'u2', toolName: 'COMMAND', decision: 'deny', reason: 'x', durationMs: 5, errored: true, tenantId: 't1' });
    assert.strictEqual(r.decision, 'deny');
    assert.strictEqual(r.reason, 'x');
    assert.strictEqual(r.durationMs, 5);
    assert.strictEqual(r.errored, true);
    assert.strictEqual(r.tenantId, 't1');
  });
  it('makeUsageRecord fills the timestamp default', () => {
    const r = makeUsageRecord({ runId: 'r1', actorId: 'u1', toolName: 'READ_FILE', cost: 0.01 });
    assert.strictEqual(r.cost, 0.01);
    assert.strictEqual(typeof r.timestamp, 'string');
    assert.ok(!Number.isNaN(Date.parse(r.timestamp)));
  });
});
