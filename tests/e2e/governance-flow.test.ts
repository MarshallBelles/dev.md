// End-to-end coverage of the GOVERNANCE layer through the REAL in-process
// GovernanceEngine (no LLM, fully deterministic). Drives the `tool` RPC method
// against the default tool registry and asserts fail-closed policy behaviour,
// approval gating, audit/usage fan-out and streaming.
import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceEngine } from '../../dist/rpc/engine.js';
import { GovernanceChain, buildDefaultChain } from '../../dist/governance/chain.js';
import { AuthorizationMiddleware, ApprovalMiddleware } from '../../dist/governance/middleware.js';
import { request, isEvent } from '../../dist/rpc/protocol.js';

const resultOf = (m: any): any => (m as { result: any }).result;

// Well-formed WRITE_FILE input: a quoted path followed by a fenced code block
// holding the file contents (see src/parser/markdown.ts extractCodeBlock /
// extractPath and src/tools/adapters.ts writeFileAdapter).
const writeFileInput = (cwd: string, name: string, content: string): string =>
  `"${join(cwd, name)}"\n\n\`\`\`\n${content}\n\`\`\``;

// Returns the file's contents on disk, or null if the adapter never created it.
const readIfExists = (path: string): string | null =>
  existsSync(path) ? readFileSync(path, 'utf-8') : null;

const mkCwd = () => mkdtempSync(join(tmpdir(), 'governance-flow-'));

describe('E2E: Governance flow (in-process engine)', () => {
  const dirs = new Set<string>();
  const tempCwd = () => {
    const d = mkCwd();
    dirs.add(d);
    return d;
  };
  afterEach(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    dirs.clear();
  });

  it('allows a normal WRITE_FILE on the default chain and reads it back', async () => {
    const cwd = tempCwd();
    const engine = new GovernanceEngine();
    let seq = 0;

    const write = await engine.handle(
      request('t1', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'WRITE_FILE',
        input: writeFileInput(cwd, 'ok.txt', 'hi'),
        cwd,
        actor: { id: 'u1' },
      }),
      () => undefined,
    );
    const r = resultOf(write);
    assert.strictEqual(r.errored, false, `expected a successful write, got: ${JSON.stringify(r)}`);
    assert.match(r.outcome, /File written/);
    assert.strictEqual(readIfExists(join(cwd, 'ok.txt')), 'hi', 'file should exist on disk with the written content');

    const read = await engine.handle(
      request('t2', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'READ_FILE',
        input: `"${join(cwd, 'ok.txt')}"`,
        cwd,
        actor: { id: 'u1' },
      }),
      () => undefined,
    );
    assert.strictEqual(resultOf(read).outcome, 'hi', 'READ_FILE should return exactly what was written');
  });

  it('fails closed when the tool capability is not authorized', async () => {
    // The AuthorizationMiddleware authorizes on the TOOL's capabilities, not the
    // actor's scopes: WRITE_FILE carries the 'write' capability, so granting only
    // the 'read' scope must fail closed and never touch the filesystem.
    const cwd = tempCwd();
    const engine = new GovernanceEngine({
      buildChain: (_actor, runId) => new GovernanceChain().use(new AuthorizationMiddleware({ allowedScopes: ['read'] })),
    });
    let seq = 0;

    const res = await engine.handle(
      request('t', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'WRITE_FILE',
        input: writeFileInput(cwd, 'no.txt', 'denied'),
        cwd,
        actor: { id: 'c1', scopes: ['read'] },
      }),
      () => undefined,
    );
    const r = resultOf(res);
    assert.ok(r.outcome.startsWith('ERROR:'), `expected a governance denial, got: ${r.outcome}`);
    assert.match(r.outcome, /denied by governance/);
    assert.strictEqual(r.errored, true);
    assert.strictEqual(readIfExists(join(cwd, 'no.txt')), null, 'the adapter must never run for a denied tool');
  });

  it('allows the same tool when the actor holds the required scope', async () => {
    const cwd = tempCwd();
    const engine = new GovernanceEngine({
      buildChain: (_actor, runId) => new GovernanceChain().use(new AuthorizationMiddleware({ allowedScopes: ['write'] })),
    });
    let seq = 0;

    const res = await engine.handle(
      request('t', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'WRITE_FILE',
        input: writeFileInput(cwd, 'ok.txt', 'allowed'),
        cwd,
        actor: { id: 'c1', scopes: ['write'] },
      }),
      () => undefined,
    );
    const r = resultOf(res);
    assert.strictEqual(r.errored, false, `expected success, got: ${JSON.stringify(r)}`);
    assert.strictEqual(readIfExists(join(cwd, 'ok.txt')), 'allowed');
  });

  it('denies a denied-scoped actor even when the tool capability is allowed', async () => {
    const cwd = tempCwd();
    const engine = new GovernanceEngine({
      buildChain: (_actor, runId) => new GovernanceChain().use(new AuthorizationMiddleware({ deniedScopes: ['blocked'] })),
    });
    let seq = 0;

    const res = await engine.handle(
      request('t', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'WRITE_FILE',
        input: writeFileInput(cwd, 'no.txt', 'x'),
        cwd,
        actor: { id: 'c1', scopes: ['blocked'] },
      }),
      () => undefined,
    );
    const r = resultOf(res);
    assert.ok(r.outcome.startsWith('ERROR:'), `expected denial, got: ${r.outcome}`);
    assert.match(r.outcome, /denied by governance/);
    assert.strictEqual(readIfExists(join(cwd, 'no.txt')), null);
  });

  it('executes a WRITE_FILE once approval is granted', async () => {
    const cwd = tempCwd();
    const approval = new ApprovalMiddleware({ requireApprovalFor: ['WRITE_FILE'], approver: () => true });
    const engine = new GovernanceEngine({
      buildChain: (_actor, runId) => new GovernanceChain().use(approval),
    });
    let seq = 0;

    const res = await engine.handle(
      request('t', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'WRITE_FILE',
        input: writeFileInput(cwd, 'ok.txt', 'approved'),
        cwd,
        actor: { id: 'c1' },
      }),
      () => undefined,
    );
    const r = resultOf(res);
    assert.strictEqual(r.errored, false, `expected success, got: ${JSON.stringify(r)}`);
    assert.strictEqual(readIfExists(join(cwd, 'ok.txt')), 'approved');
    assert.strictEqual(approval.approverCalls, 1, 'the approver should have been consulted exactly once');
  });

  it('denies and never writes when approval is withheld', async () => {
    const cwd = tempCwd();
    const approval = new ApprovalMiddleware({ requireApprovalFor: ['WRITE_FILE'], approver: () => false });
    const engine = new GovernanceEngine({
      buildChain: (_actor, runId) => new GovernanceChain().use(approval),
    });
    let seq = 0;

    const res = await engine.handle(
      request('t', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'WRITE_FILE',
        input: writeFileInput(cwd, 'no.txt', 'x'),
        cwd,
        actor: { id: 'c1' },
      }),
      () => undefined,
    );
    const r = resultOf(res);
    assert.ok(r.outcome.startsWith('ERROR:'), `expected denial, got: ${r.outcome}`);
    assert.match(r.outcome, /denied by governance/);
    assert.strictEqual(r.errored, true);
    assert.strictEqual(readIfExists(join(cwd, 'no.txt')), null);
    assert.ok(approval.approverCalls >= 1, 'the approver must have been consulted before denial');
  });

  it('fans audit, usage and cost records out for a governed tool call', async () => {
    const cwd = tempCwd();
    const auditRecords: any[] = [];
    const usageRecords: any[] = [];
    const engine = new GovernanceEngine({
      buildChain: (actor, runId) =>
        buildDefaultChain({
          actor,
          runId,
          pricePerToken: 0.001,
          onAudit: (rec) => { auditRecords.push(rec); },
          onUsage: (rec) => { usageRecords.push(rec); },
        }),
    });
    let seq = 0;

    const res = await engine.handle(
      request('t', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'WRITE_FILE',
        input: writeFileInput(cwd, 'ok.txt', 'x'),
        cwd,
        actor: { id: 'u1' },
      }),
      () => undefined,
    );
    assert.strictEqual(resultOf(res).errored, false);

    const audit = auditRecords.find((r) => r.toolName === 'WRITE_FILE');
    assert.ok(audit, 'an AuditRecord should be emitted for WRITE_FILE');
    assert.strictEqual(audit.decision, 'allow');

    const usage = usageRecords.find((r) => r.toolName === 'WRITE_FILE');
    assert.ok(usage, 'a UsageRecord should be emitted for WRITE_FILE');
  });

  it('returns 404 for an unknown tool', async () => {
    const cwd = tempCwd();
    const engine = new GovernanceEngine();
    let seq = 0;

    const res = await engine.handle(
      request('t', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'NO_SUCH_TOOL',
        input: '',
        cwd,
        actor: { id: 'u1' },
      }),
      () => undefined,
    );
    assert.strictEqual(resultOf(res).error.code, 404);
  });

  it('emits a streaming tool event for a real execution', async () => {
    const cwd = tempCwd();
    const engine = new GovernanceEngine();
    let seq = 0;
    const events: any[] = [];

    const res = await engine.handle(
      request('t', 'tool', {
        runId: `run-${++seq}`,
        toolName: 'WRITE_FILE',
        input: writeFileInput(cwd, 'ok.txt', 'x'),
        cwd,
        actor: { id: 'u1' },
      }),
      (m) => { events.push(m); },
    );
    assert.strictEqual(resultOf(res).errored, false);
    const toolEvents = events.filter((m) => isEvent(m) && m.event === 'tool');
    assert.ok(toolEvents.length >= 1, 'expected at least one streaming tool event');
  });
});
