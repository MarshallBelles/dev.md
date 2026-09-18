import { request, serialize, parse, isEvent, type RpcMessage, type RpcEvent, type RunParams, type ToolCallParams } from '../rpc/protocol.js';

export interface ToolInfo {
  name: string;
  label: string;
  description: string;
  capabilities: string[];
  mutates: boolean;
}

type Listener = (e: RpcEvent) => void;

/** Browser-friendly client for the dev-md governed microservice.
 *
 *  Unlike the Node client (callback-based), this one uses an
 *  event-subscription model (`on`/`off`) and is free of Node-only APIs so it
 *  can run in the browser. The browser cannot execute local tools directly, so
 *  every action is proxied through the microservice (which holds the tool
 *  registry + governance). */
export class BrowserAgentClient {
  #baseUrl: string;
  #nextId = 0;
  #listeners = new Map<string, Set<Listener>>();

  constructor(baseUrl: string) {
    this.#baseUrl = String(baseUrl).replace(/\/+$/, '');
  }

  get baseUrl(): string {
    return this.#baseUrl;
  }

  on(event: string, cb: Listener): void {
    let set = this.#listeners.get(event);
    if (!set) {
      set = new Set();
      this.#listeners.set(event, set);
    }
    set.add(cb);
  }

  off(event: string, cb: Listener): void {
    this.#listeners.get(event)?.delete(cb);
  }

  async listTools(): Promise<ToolInfo[]> {
    const final = await this.#post('list_tools', {}, () => undefined);
    return ((final as any).result?.tools as ToolInfo[]) ?? [];
  }

  async run(params: RunParams): Promise<{ events: RpcEvent[]; result: any }> {
    const events: RpcEvent[] = [];
    const final = await this.#post('run', params, (e) => { events.push(e); this.#dispatch(e); });
    return { events, result: (final as any).result };
  }

  async tool(params: Omit<ToolCallParams, 'runId'> & { runId?: string; cwd?: string; actor?: unknown }): Promise<{ events: RpcEvent[]; result: any }> {
    const events: RpcEvent[] = [];
    const final = await this.#post('tool', params, (e) => { events.push(e); this.#dispatch(e); });
    return { events, result: (final as any).result };
  }

  async stop(runId: string): Promise<boolean> {
    const final = await this.#post('stop', { runId }, () => undefined);
    return Boolean((final as any).result?.stopped);
  }

  async status(): Promise<unknown> {
    const final = await this.#post('status', {}, () => undefined);
    return (final as any).result?.runs ?? [];
  }

  #dispatch(m: RpcMessage): void {
    if (!isEvent(m)) return;
    for (const cb of this.#listeners.get(m.event) ?? []) cb(m);
  }

  async #post(method: string, params: unknown, onEvent?: (e: RpcEvent) => void): Promise<RpcMessage> {
    const id = `browser-${++this.#nextId}`;
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
        if (onEvent && isEvent(m)) onEvent(m);
        this.#dispatch(m);
      }
    }
    if (buffer.trim()) {
      const m = parse(buffer) as RpcMessage;
      last = m;
      if (onEvent && isEvent(m)) onEvent(m);
      this.#dispatch(m);
    }
    if (!last) throw new Error(`no messages received for ${method}`);
    return last;
  }
}
