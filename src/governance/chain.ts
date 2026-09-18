import { allow, type PolicyDecision, type ToolInvocationContext, type ToolInvocationResult } from './types.js';

import type { Actor } from './types.js';
import { AuditMiddleware, CostMiddleware, UsageMiddleware, AuthorizationMiddleware } from './middleware.js';
import type { AuditRecord, UsageRecord } from './types.js';

/** A middleware the chain can run. `observe()` is optional so plain decision
 *  middleware coexist with observational (audit/usage/cost) middleware. */
export interface ChainMiddleware {
  readonly name: string;
  decide(ctx: ToolInvocationContext): Promise<PolicyDecision> | PolicyDecision;
  observe?(result: ToolInvocationResult): void | Promise<void>;
}

export class GovernanceChain {
  #middleware: ChainMiddleware[];
  constructor(middleware: ChainMiddleware[] = []) {
    this.#middleware = [...middleware];
  }
  get length(): number { return this.#middleware.length; }
  get names(): string[] { return this.#middleware.map((m) => m.name); }
  use(middleware: ChainMiddleware): this {
    this.#middleware.push(middleware);
    return this;
  }

  /** Evaluate the chain; the first middleware that does not allow wins. */
  async runDecide(ctx: ToolInvocationContext): Promise<PolicyDecision> {
    for (const m of this.#middleware) {
      const decision = await m.decide(ctx);
      if (decision.status !== 'allow') return decision;
    }
    return allow();
  }

  /** Run the observe() phase of every middleware that provides one. */
  async runObserve(result: ToolInvocationResult): Promise<void> {
    for (const m of this.#middleware) {
      if (m.observe) await m.observe(result);
    }
  }
}

export interface DefaultChainOptions {
  actor: Actor;
  runId: string;
  /** Scopes a tool must carry to be allowed. Empty = permissive. */
  allowedScopes?: string[];
  pricePerToken?: number;
  onAudit?: (record: AuditRecord) => void | Promise<void>;
  onUsage?: (record: UsageRecord) => void | Promise<void>;
}

/** Convenience: an authorization (permissive unless scopes configured) + audit +
 *  usage + cost chain, so a host can install governance in one call. */
export const buildDefaultChain = (opts: DefaultChainOptions): GovernanceChain => {
  const audit = opts.onAudit ?? (() => undefined);
  const usage = opts.onUsage ?? (() => undefined);
  const chain = new GovernanceChain();
  chain
    .use(new AuthorizationMiddleware({ allowedScopes: opts.allowedScopes ?? [] }))
    .use(new AuditMiddleware({ onRecord: audit }))
    .use(new UsageMiddleware({ onRecord: usage }))
    .use(new CostMiddleware({ onRecord: usage, pricePerToken: opts.pricePerToken ?? 0 }));
  return chain;
};
