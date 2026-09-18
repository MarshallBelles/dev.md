import { serialize, parse, request, isEvent, type RpcMessage, type RpcEvent, type RunParams, type ToolCallParams } from './protocol.js';

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  capabilities: string[];
  mutates: boolean;
}

/** Typed client for the dev-md governed microservice. Streams events as they
 *  arrive and resolves to the final result message of each call. */
export class GovernanceClient {
  #baseUrl: string;
  #nextId = 0;

  constructor(baseUrl: string) {
    this.#baseUrl = String(baseUrl).replace(/\/+$/, '');
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  async listTools(): Promise<ToolInfo[]> {
    const final = await this.#stream('list_tools', {}, () => undefined);
    return ((final as any).result?.tools as ToolInfo[]) ?? [];
  }

  async run(params: RunParams, onEvent?: (e: RpcEvent) => void): Promise<RpcMessage> {
    return this.#stream('run', params, onEvent);
  }

  async tool(params: ToolCallParams & { cwd?: string; actor?: unknown }, onEvent?: (e: RpcEvent) => void): Promise<RpcMessage> {
    return this.#stream('tool', params, onEvent);
  }

  async stop(runId: string): Promise<boolean> {
    const final = await this.#stream('stop', { runId }, () => undefined);
    return Boolean((final as any).result?.stopped);
  }

  async status(): Promise<unknown> {
    const final = await this.#stream('status', {}, () => undefined);
    return (final as any).result?.runs ?? [];
  }

  async #stream(method: string, params: unknown, onEvent?: (e: RpcEvent) => void): Promise<RpcMessage> {
    const id = `cli-${++this.#nextId}`;
    const res = await fetch(this.#baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: serialize(request(id, method, params)),
    });
    if (!res.body) throw new Error(`no response body for ${method}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let last: RpcMessage | undefined;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        const m = parse(line) as RpcMessage;
        last = m;
        if (isEvent(m) && onEvent) onEvent(m);
      }
    }
    if (buffer.trim()) {
      const m = parse(buffer) as RpcMessage;
      last = m;
      if (isEvent(m) && onEvent) onEvent(m);
    }
    if (!last) throw new Error(`no messages received for ${method}`);
    return last;
  }
}
