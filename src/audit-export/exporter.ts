import type { AuditRecord } from '../governance/types.js';

/** Reuses the governance AuditRecord shape for SIEM ingestion. */
export type AuditEvent = AuditRecord;

/** A sink consumes audit events; may be sync or async. */
export type AuditSink = (event: AuditEvent) => void | Promise<void>;

/** Render an audit event as a Common Event Format (CEF)-style record for SIEM. */
export const toCEF = (event: AuditEvent, product = 'dev-md'): Record<string, unknown> => ({
  cefVersion: '1.1',
  productName: product,
  productVersion: '1.0',
  eventType: event.decision,
  extension: {
    actor: event.actorId,
    tenant: event.tenantId ?? '',
    tool: event.toolName,
    runId: event.runId,
    reason: event.reason ?? '',
    durationMs: event.durationMs,
    errored: event.errored,
    timestamp: event.timestamp,
  },
});

/** Collect events in memory (handy for tests and local fan-out). */
export const collectingSink = () => {
  const events: AuditEvent[] = [];
  const sink: AuditSink = (e) => { events.push(e); };
  return { sink, events };
};

/** Emits one JSON line per event to stdout (for log aggregators). */
export const consoleSink: AuditSink = (event) => {
  console.log(JSON.stringify(event));
};

/** Fans audit events out to every registered sink. */
export class AuditRunner {
  #sinks: AuditSink[];

  constructor(sinks: AuditSink[] = []) {
    this.#sinks = [...sinks];
  }

  sink(s: AuditSink): this {
    this.#sinks.push(s);
    return this;
  }

  get size(): number {
    return this.#sinks.length;
  }

  async record(event: AuditEvent): Promise<void> {
    for (const s of this.#sinks) await s(event);
  }
}
