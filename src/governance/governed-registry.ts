import { createRegistry, type ToolRegistry } from '../tools/registry.js';
import type { ToolAdapter, ToolInvocation } from '../tools/adapter.js';
import type { Actor, ToolInvocationContext } from './types.js';
import { GovernanceChain } from './chain.js';

export interface GovernedRegistryOptions {
  source: ToolRegistry;
  chain: GovernanceChain;
  actor: Actor;
  runId: string;
}

/** Wrap a source registry so every execute() is gated by the governance chain.
 *  When the chain does not return 'allow' the underlying adapter is NEVER run
 *  (fail closed) and an ERROR string is returned instead. */
export const makeGovernedRegistry = (opts: GovernedRegistryOptions): ToolRegistry => {
  const { source, chain, actor, runId } = opts;
  const governed = createRegistry();

  for (const adapter of source.list()) {
    const wrapped: ToolAdapter = {
      metadata: adapter.metadata,
      execute: async (invocation: ToolInvocation) => {
        const gctx: ToolInvocationContext = {
          toolName: adapter.metadata.name,
          label: adapter.metadata.label,
          capabilities: adapter.metadata.capabilities,
          mutates: adapter.metadata.mutates,
          rawInput: invocation.input,
          cwd: invocation.ctx.cwd,
          automated: invocation.ctx.automated,
          actor,
          runId,
        };

        const decision = await chain.runDecide(gctx);
        if (decision.status === 'allow') {
          const start = Date.now();
          const outcome = await adapter.execute(invocation);
          await chain.runObserve({
            toolName: adapter.metadata.name,
            outcome,
            errored: outcome.startsWith('ERROR:'),
            durationMs: Date.now() - start,
          });
          return outcome;
        }

        const reason = decision.status === 'error' ? (decision.reason || 'policy error') : (decision.reason || 'denied');
        return `ERROR: tool ${adapter.metadata.name} denied by governance (${decision.status}): ${reason}`;
      },
    };
    governed.register(wrapped);
  }
  return governed;
};
