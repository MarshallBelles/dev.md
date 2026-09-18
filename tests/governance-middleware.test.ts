import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  AuthorizationMiddleware,
  ApprovalMiddleware,
  AuditMiddleware,
  UsageMiddleware,
  CostMiddleware,
} from '../dist/governance/middleware.js';
import type { ToolInvocationContext, ToolInvocationResult, AuditRecord, UsageRecord } from '../dist/governance/types.js';

const ctx = (over: Partial<ToolInvocationContext> = {}): ToolInvocationContext => ({
  toolName: 'READ_FILE', label: 'Read File', capabilities: ['read'], mutates: false,
  rawInput: '"f"', cwd: '/tmp', automated: true,
  actor: { id: 'u1', scopes: ['read'], tenantId: 't1' }, runId: 'run1',
  ...over,
});

const result = (over: Partial<ToolInvocationResult> = {}): ToolInvocationResult => ({
  toolName: 'READ_FILE', outcome: 'ok', errored: false, durationMs: 10, ...over,
});

describe('AuthorizationMiddleware (Phase 2b)', () => {
  it('allows tools whose capability is in the allowed set', () => {
    const m = new AuthorizationMiddleware({ allowedScopes: ['write'] });
    assert.deepStrictEqual(m.decide(ctx({ toolName: 'WRITE_FILE', capabilities: ['write'] })), { status: 'allow' });
  });
  it('denies tools whose capability is not allowed', () => {
    const m = new AuthorizationMiddleware({ allowedScopes: ['write'] });
    const d = m.decide(ctx({ toolName: 'READ_FILE', capabilities: ['read'] }));
    assert.strictEqual(d.status, 'deny');
  });
  it('is permissive when allowedScopes is empty', () => {
    const m = new AuthorizationMiddleware();
    assert.deepStrictEqual(m.decide(ctx({ toolName: 'KILL_BACKGROUND_PROCESS', capabilities: ['process'] })), { status: 'allow' });
  });
  it('denies a blocked actor id or scope and allows a clean actor', () => {
    const m = new AuthorizationMiddleware({ deniedScopes: ['blocked', 'bad-scope'] });
    assert.strictEqual(m.decide(ctx({ actor: { id: 'blocked', scopes: ['read'] } })).status, 'deny');
    assert.strictEqual(m.decide(ctx({ actor: { id: 'u1', scopes: ['bad-scope'] } })).status, 'deny');
    assert.strictEqual(m.decide(ctx({ actor: { id: 'good', scopes: ['read'] } })).status, 'allow');
  });
});

describe('ApprovalMiddleware (Phase 2b)', () => {
  it('allows non-approved tools without ever calling the approver', async () => {
    let calls = 0;
    const m = new ApprovalMiddleware({ requireApprovalFor: ['WRITE_FILE'], approver: async () => { calls++; return true; } });
    assert.deepStrictEqual(await m.decide(ctx({ toolName: 'READ_FILE', capabilities: ['read'] })), { status: 'allow' });
    assert.strictEqual(calls, 0);
  });
  it('consults the approver for approved tools and caches within the run', async () => {
    let calls = 0;
    const m = new ApprovalMiddleware({ requireApprovalFor: ['WRITE_FILE'], approver: async () => { calls++; return true; } });
    assert.deepStrictEqual(await m.decide(ctx({ toolName: 'WRITE_FILE', capabilities: ['write'], runId: 'r1' })), { status: 'allow' });
    assert.deepStrictEqual(await m.decide(ctx({ toolName: 'WRITE_FILE', capabilities: ['write'], runId: 'r1' })), { status: 'allow' });
    assert.strictEqual(calls, 1, 'approver should be called once then cached within the run');
  });
  it('denies when the approver rejects', async () => {
    const m = new ApprovalMiddleware({ requireApprovalFor: ['WRITE_FILE'], approver: async () => false });
    assert.strictEqual((await m.decide(ctx({ toolName: 'WRITE_FILE', capabilities: ['write'] }))).status, 'deny');
  });
});

describe('AuditMiddleware (Phase 2b)', () => {
  it('always allows and records one entry per observation', async () => {
    const records: AuditRecord[] = [];
    const m = new AuditMiddleware({ onRecord: (r) => { records.push(r); } });
    assert.deepStrictEqual(m.decide(ctx({ toolName: 'WRITE_FILE', capabilities: ['write'] })), { status: 'allow' });
    await m.observe(result({ toolName: 'WRITE_FILE', errored: false }));
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].toolName, 'WRITE_FILE');
    assert.strictEqual(records[0].decision, 'allow');
    assert.strictEqual(records[0].runId, 'run1');
    assert.strictEqual(records[0].actorId, 'u1');
  });
  it('records deny for errored observations', async () => {
    const records: AuditRecord[] = [];
    const m = new AuditMiddleware({ onRecord: (r) => { records.push(r); } });
    m.decide(ctx());
    await m.observe(result({ errored: true }));
    assert.strictEqual(records[0].decision, 'deny');
    assert.strictEqual(records[0].errored, true);
  });
});

describe('Usage & Cost middleware (Phase 2b)', () => {
  it('usage records tokens for the invoking actor/run', () => {
    const records: UsageRecord[] = [];
    const m = new UsageMiddleware({ onRecord: (r) => { records.push(r); } });
    m.decide(ctx());
    m.observe(result({ toolName: 'READ_FILE', tokens: { promptTokens: 10, completionTokens: 5, total: 15 } }));
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].tokens?.total, 15);
    assert.strictEqual(records[0].actorId, 'u1');
  });
  it('cost computes cost from tokens * pricePerToken', () => {
    const records: UsageRecord[] = [];
    const m = new CostMiddleware({ onRecord: (r) => { records.push(r); }, pricePerToken: 0.001 });
    m.decide(ctx());
    m.observe(result({ toolName: 'READ_FILE', tokens: { promptTokens: 600, completionTokens: 400, total: 1000 } }));
    assert.strictEqual(records[0].cost, 1);
  });
});
