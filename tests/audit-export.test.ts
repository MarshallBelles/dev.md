import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AuditRunner, collectingSink, consoleSink, toCEF } from '../dist/audit-export/exporter.js';
import type { AuditEvent, AuditSink } from '../dist/audit-export/exporter.js';

const mk = (over: Partial<AuditEvent> = {}): AuditEvent => ({
  runId: 'r1',
  actorId: 'u1',
  tenantId: 't1',
  toolName: 'WRITE_FILE',
  decision: 'allow',
  reason: 'ok',
  timestamp: '2026-01-01T00:00:00.000Z',
  durationMs: 42,
  errored: false,
  ...over,
});

describe('toCEF (Phase 5c)', () => {
  it('produces a CEF-shaped record', () => {
    const cef = toCEF(mk());
    assert.strictEqual(cef.productName, 'dev-md');
    assert.strictEqual(cef.eventType, 'allow');
    const ext = cef.extension as Record<string, unknown>;
    assert.strictEqual(ext.actor, 'u1');
    assert.strictEqual(ext.tool, 'WRITE_FILE');
    assert.strictEqual(ext.tenant, 't1');
    assert.strictEqual(ext.durationMs, 42);
    assert.strictEqual(ext.errored, false);
  });

  it('honours a custom product name', () => {
    assert.strictEqual(toCEF(mk(), 'acme-agent').productName, 'acme-agent');
  });

  it('records deny decisions', () => {
    const cef = toCEF(mk({ decision: 'deny', reason: 'policy' }));
    assert.strictEqual(cef.eventType, 'deny');
    assert.strictEqual((cef.extension as Record<string, unknown>).reason, 'policy');
  });
});

describe('AuditRunner (Phase 5c)', () => {
  it('forwards events to every sink (sync + async)', async () => {
    const a = collectingSink();
    const b: AuditEvent[] = [];
    const asyncSink: AuditSink = async (e) => { b.push(e); };
    const runner = new AuditRunner([a.sink, asyncSink]);
    await runner.record(mk());
    assert.strictEqual(a.events.length, 1);
    assert.strictEqual(b.length, 1);
    assert.strictEqual(a.events[0].toolName, 'WRITE_FILE');
  });

  it('sink() appends sinks before recording', async () => {
    const c = collectingSink();
    const runner = new AuditRunner().sink(c.sink);
    assert.strictEqual(runner.size, 1);
    await runner.record(mk());
    assert.strictEqual(c.events.length, 1);
  });

  it('supports multiple records', async () => {
    const c = collectingSink();
    const runner = new AuditRunner([c.sink]);
    await runner.record(mk());
    await runner.record(mk({ toolName: 'READ_FILE' }));
    assert.strictEqual(c.events.length, 2);
    assert.strictEqual(c.events[1].toolName, 'READ_FILE');
  });
});

describe('consoleSink (Phase 5c)', () => {
  it('serializes the event to stdout without throwing', async () => {
    const logged: string[] = [];
    const orig = console.log;
    console.log = (s: unknown) => { logged.push(String(s)); };
    try {
      await consoleSink(mk());
    } finally {
      console.log = orig;
    }
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(JSON.parse(logged[0]).toolName, 'WRITE_FILE');
  });
});
