// E2E tests for the audit-export cross-cutting feature, driven through the real
// exporter (toCEF / collectingSink / AuditRunner) and a real in-process governed
// tool call via GovernanceEngine. Deterministic: no LLM.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { toCEF, collectingSink, AuditRunner } from '../../dist/audit-export/exporter.js';
import { GovernanceEngine } from '../../dist/rpc/engine.js';
import { buildDefaultChain } from '../../dist/governance/chain.js';
import type { AuditRecord, UsageRecord } from '../../dist/governance/types.js';
import type { RpcMessage } from '../../dist/rpc/protocol.js';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// A well-formed WRITE_FILE input: a quoted path on the first line followed by a
// fenced code block containing the file content.
const BT = '`';
const writeInput = (absPath: string, content: string): string => `${JSON.stringify(absPath)}\n${BT}${BT}${BT}\n${content}\n${BT}${BT}${BT}\n`;

const sample: AuditRecord = {
  runId: 'r1',
  actorId: 'actor1',
  tenantId: 'acme',
  toolName: 'WRITE_FILE',
  decision: 'allow',
  reason: 'x',
  timestamp: '2020-01-01T00:00:00Z',
  durationMs: 5,
  errored: false,
};

describe('E2E: Audit Export (CEF + fan-out)', () => {
  it('renders an audit record as a CEF record', () => {
    const cef = toCEF(sample);
    assert.strictEqual(cef.cefVersion, '1.1');
    assert.strictEqual(cef.productName, 'dev-md');
    assert.strictEqual(cef.productVersion, '1.0');
    assert.strictEqual(cef.eventType, 'allow');

    const ext = cef.extension as Record<string, unknown>;
    assert.strictEqual(ext.actor, 'actor1');
    assert.strictEqual(ext.tenant, 'acme');
    assert.strictEqual(ext.tool, 'WRITE_FILE');
    assert.strictEqual(ext.runId, 'r1');
    assert.strictEqual(ext.reason, 'x');
    assert.strictEqual(ext.durationMs, 5);
    assert.strictEqual(ext.errored, false);
    assert.strictEqual(ext.timestamp, '2020-01-01T00:00:00Z');
  });

  it('fans an event out to every registered sink', async () => {
    const collector = collectingSink();
    const seen: { toolName: string }[] = [];

    const runner = new AuditRunner();
    runner.sink(collector.sink);
    runner.sink((e: AuditRecord) => { seen.push({ toolName: e.toolName }); });
    assert.strictEqual(runner.size, 2);

    await runner.record(sample);

    assert.strictEqual(collector.events.length, 1);
    assert.strictEqual(collector.events[0].toolName, 'WRITE_FILE');
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0].toolName, 'WRITE_FILE');
  });
});

describe('E2E: Audit Export (governed engine integration)', () => {
  let dir: string;
  let filePath: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'audit-'));
    filePath = join(dir, 'out.txt');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('captures an audit + usage record from a real governed WRITE_FILE call', async () => {
    const input = writeInput(filePath, 'hello governed world');

    const audit: AuditRecord[] = [];
    const usage: UsageRecord[] = [];
    // The engine uses buildDefaultChain internally; wire audit/usage capture via
    // its public buildChain option (which calls buildDefaultChain with hooks).
    const engine = new GovernanceEngine({
      buildChain: (actor, runId) =>
        buildDefaultChain({
          actor,
          runId,
          onAudit: (r: AuditRecord) => { audit.push(r); },
          onUsage: (r: UsageRecord) => { usage.push(r); },
        }),
    });

    const sent: { tool: string; result: string }[] = [];
    const res = await engine.handle(
      { id: 'r1', method: 'tool', params: { runId: 'r1', toolName: 'WRITE_FILE', input, cwd: dir } },
      (m: RpcMessage) => {
        const anyMsg = m as unknown as { event: string; payload: { tool: string; result: string } };
        if (anyMsg.event === 'tool') {
          sent.push({ tool: anyMsg.payload.tool, result: anyMsg.payload.result });
        }
      }
    );

    const outcome = (res as { result: { errored: boolean; outcome: string } }).result;

    // Ground truth: the governed tool actually ran and wrote the file.
    assert.strictEqual(outcome.errored, false, JSON.stringify(outcome));
    assert.ok(existsSync(filePath), `file must exist at ${filePath}`);
    assert.ok(outcome.outcome.startsWith('File written'), JSON.stringify(outcome));

    // The audit capture captured exactly the governed decision.
    assert.strictEqual(audit.length, 1, 'one audit record expected');
    assert.strictEqual(audit[0].toolName, 'WRITE_FILE');
    assert.strictEqual(audit[0].decision, 'allow');
    assert.strictEqual(audit[0].errored, false);
    assert.strictEqual(audit[0].runId, 'r1');

    // The usage capture saw the call too.
    assert.ok(usage.length >= 1, 'at least one usage record expected');
    assert.strictEqual(usage[0].toolName, 'WRITE_FILE');

    // The engine also emitted a tool event over the send callback.
    assert.ok(sent.some((m) => m.tool === 'WRITE_FILE'));
  });
});
