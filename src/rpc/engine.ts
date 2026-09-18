import { randomUUID } from 'node:crypto';
import { createAgent } from '../lib/index.js';
import { getRegistry, setRegistry } from '../tools/index.js';
import type { ToolRegistry } from '../tools/registry.js';
import { makeGovernedRegistry } from '../governance/governed-registry.js';
import { buildDefaultChain, GovernanceChain } from '../governance/chain.js';
import { result, rpcError, event, type RpcMessage, type RpcRequest, type RunParams, type ToolCallParams } from './protocol.js';
import type { Actor } from '../governance/types.js';

export interface ServerOptions {
  /** Registry that runs are governed against. Defaults to the process default. */
  sourceRegistry?: ToolRegistry;
  /** Builds the governance chain for a run/tool call. Defaults to buildDefaultChain. */
  buildChain?: (actor: Actor, runId: string, params: RunParams) => GovernanceChain;
  /** Optional SIEM hook invoked for every audit record. */
  onAudit?: (record: import('../governance/types.js').AuditRecord) => void | Promise<void>;
}

type Send = (m: RpcMessage) => void | Promise<void>;

interface RunSession {
  runId: string;
  controller: AbortController;
}

export class GovernanceEngine {
  #source: ToolRegistry;
  #buildChain: ServerOptions['buildChain'];
  #runs = new Map<string, RunSession>();

  constructor(options: ServerOptions = {}) {
    this.#source = options.sourceRegistry ?? getRegistry();
    this.#buildChain = options.buildChain;
  }

  listTools() {
    return this.#source.list().map((a) => ({
      name: a.metadata.name,
      label: a.metadata.label,
      description: a.metadata.description,
      capabilities: a.metadata.capabilities,
      mutates: a.metadata.mutates,
    }));
  }

  status(runId: string) {
    const s = this.#runs.get(runId);
    return { runId, active: Boolean(s) };
  }

  allStatus() {
    return [...this.#runs.keys()].map((id) => this.status(id));
  }

  stop(runId: string): boolean {
    const s = this.#runs.get(runId);
    if (!s) return false;
    s.controller.abort();
    return true;
  }

  async handle(req: RpcRequest, send: Send): Promise<RpcMessage> {
    const params = req.params as Record<string, unknown>;
    switch (req.method) {
      case 'list_tools':
        return result(req.id, { tools: this.listTools() });
      case 'status':
        return result(req.id, { runs: this.allStatus() });
      case 'stop': {
        const runId = params.runId as string | undefined;
        return result(req.id, { stopped: runId ? this.stop(runId) : false });
      }
      case 'tool':
        return await this.#handleTool(req.id, params as unknown as ToolCallParams & { cwd?: string; actor?: Actor }, send);
      case 'run':
        return await this.#handleRun(req.id, params as unknown as RunParams, send);
      default:
        return rpcError(req.id, 404, `unknown method: ${req.method}`);
    }
  }

  async #handleTool(id: string, p: ToolCallParams & { cwd?: string; actor?: Actor }, send: Send): Promise<RpcMessage> {
    const cwd = p.cwd ?? process.cwd();
    const actor = p.actor ?? { id: 'anonymous' };
    const runId = p.runId ?? `tool-${randomUUID()}`;
    const chain = this.#buildChain ? this.#buildChain(actor, runId, {} as RunParams) : buildDefaultChain({ actor, runId });

    const adapter = this.#source.get(p.toolName);
    if (!adapter) return rpcError(id, 404, `unknown tool: ${p.toolName}`);

    const decision = await chain.runDecide({
      toolName: p.toolName,
      label: adapter.metadata.label,
      capabilities: adapter.metadata.capabilities,
      mutates: adapter.metadata.mutates,
      rawInput: p.input,
      cwd,
      automated: true,
      actor,
      runId,
    });

    if (decision.status !== 'allow') {
      const outcome = `ERROR: tool ${p.toolName} denied by governance (${decision.status}): ${decision.reason || 'denied'}`;
      return result(id, { runId, toolName: p.toolName, outcome, errored: true });
    }

    const previous = getRegistry();
    setRegistry(makeGovernedRegistry({ source: this.#source, chain, actor, runId }));
    try {
      const ctx = { cwd, automated: true };
      const start = Date.now();
      const outcome = await adapter.execute({ input: p.input, ctx });
      const errored = outcome.startsWith('ERROR:');
      await chain.runObserve({ toolName: p.toolName, outcome, errored, durationMs: Date.now() - start });
      send(event(id, 'tool', { runId, tool: p.toolName, input: p.input, result: outcome }));
      return result(id, { runId, toolName: p.toolName, outcome, errored });
    } finally {
      setRegistry(previous);
    }
  }

  async #handleRun(id: string, p: RunParams, send: Send): Promise<RpcMessage> {
    const runId = p.runId ?? `run-${randomUUID()}`;
    const actor = p.actor ?? { id: 'anonymous' };
    const chain = this.#buildChain ? this.#buildChain(actor, runId, p) : buildDefaultChain({ actor, runId });
    const previous = getRegistry();
    const controller = new AbortController();
    this.#runs.set(runId, { runId, controller });

    setRegistry(makeGovernedRegistry({ source: this.#source, chain, actor, runId }));
    send(event(id, 'start', { runId, cwd: p.cwd }));

    const emit = (name: string, payload: Record<string, unknown>) => send(event(id, name, { runId, ...payload }));

    try {
      const agent = createAgent({
        config: p.config,
        cwd: p.cwd,
        automated: p.automated ?? true,
        signal: controller.signal,
      });

      agent.events.on('token', (x: { token: string }) => emit('token', { token: x.token }));
      agent.events.on('usage', (x: { promptTokens: number; completionTokens: number; total: number }) => emit('usage', { promptTokens: x.promptTokens, completionTokens: x.completionTokens, total: x.total }));
      agent.events.on('tool', (x: { tool: string; input: string; result: string }) => emit('tool', { tool: x.tool, input: x.input, result: x.result }));
      agent.events.on('delegate', (x: { label: string; result: string }) => emit('delegate', { label: x.label, result: x.result }));
      agent.events.on('compress', (x: { tokensBefore: number; tokensAfter: number }) => emit('compress', { tokensBefore: x.tokensBefore, tokensAfter: x.tokensAfter }));
      agent.events.on('save', (x: { sessionId: string }) => emit('save', { sessionId: x.sessionId }));
      agent.events.on('done', (x: { summary: string; auditPassed: boolean }) => emit('done', { summary: x.summary, auditPassed: x.auditPassed }));
      agent.events.on('maxLoopsReached', (x: { maxLoops: number }) => emit('maxLoops', { maxLoops: x.maxLoops }));
      agent.events.on('stop', () => emit('stop', {}));
      agent.events.on('error', (x: { error: Error }) => emit('error', { message: x.error.message }));

      const res = await agent.run({ prompt: p.prompt, automated: p.automated ?? true });
      switch (res.type) {
        case 'done':
          return result(id, { runId, type: 'done', summary: res.summary, auditPassed: res.auditPassed });
        case 'maxLoopsReached':
          return result(id, { runId, type: 'maxLoopsReached', maxLoops: res.maxLoops });
        case 'aborted':
          return result(id, { runId, type: 'aborted' });
        case 'idle':
          return result(id, { runId, type: 'idle' });
        default:
          return rpcError(id, 500, `run failed: ${(res as any).error.message}`);
      }
    } finally {
      this.#runs.delete(runId);
      setRegistry(previous);
    }
  }
}
