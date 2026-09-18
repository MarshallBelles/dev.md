/** The dev-md governed tool-call protocol.
 *
 *  One engine, many surfaces: the microservice (Phase 3b) speaks these shapes
 *  over HTTP; the browser/CI/fleet clients (Phase 3c/4) speak the same shapes.
 *  Every surface therefore drives the same governed engine. Messages are plain
 *  JSON objects with an `id` correlation handle; this module defines the shapes
 *  and the validation/(de)serialization helpers. */

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** A client -> server request. */
export interface RpcRequest {
  id: string;
  method: string;
  params: unknown;
}

/** A server -> client event (a point-in-time notification). */
export interface RpcEvent {
  id: string;         // correlates with the originating request id
  event: string;
  payload: unknown;
}

/** A server -> client response envelope (success or error). */
export interface RpcResult {
  id: string;
  result: unknown;    // { <value> } on success, { error: RpcError } on failure
}

export type RpcMessage = RpcRequest | RpcEvent | RpcResult;

// ---- request parameter shapes ----
export interface RunParams {
  prompt: string;
  cwd: string;
  actor: { id: string; scopes?: string[]; tenantId?: string };
  runId?: string;
  automated?: boolean;
  config?: Record<string, unknown>;
}

export interface ToolCallParams {
  runId: string;
  toolName: string;
  input: string;
}

export interface IdParams { runId: string; }

// ---- factories ----
export const request = (id: string, method: string, params: unknown = {}): RpcRequest => ({ id, method, params });

export const event = (id: string, event: string, payload: unknown = {}): RpcEvent => ({ id, event, payload });

export const result = (id: string, result: unknown): RpcResult => ({ id, result });

export const rpcError = (id: string, code: number, message: string, data?: unknown): RpcResult =>
  ({ id, result: { error: { code, message, data } as RpcError } });

// Typed event builders used by the microservice.
export const startEvent = (runId: string, cwd: string): RpcEvent => event(runId, 'start', { runId, cwd });
export const tokenEvent = (runId: string, token: string): RpcEvent => event(runId, 'token', { runId, token });
export const usageEvent = (runId: string, promptTokens: number, completionTokens: number, total: number): RpcEvent =>
  event(runId, 'usage', { runId, promptTokens, completionTokens, total });
export const toolEvent = (runId: string, tool: string, input: string, result: string): RpcEvent =>
  event(runId, 'tool', { runId, tool, input, result });
export const doneEvent = (runId: string, summary: string, auditPassed: boolean): RpcEvent =>
  event(runId, 'done', { runId, summary, auditPassed });
export const maxLoopsEvent = (runId: string, maxLoops: number): RpcEvent => event(runId, 'maxLoops', { runId, maxLoops });
export const errorEvent = (runId: string, message: string): RpcEvent => event(runId, 'error', { runId, message });

// ---- guards (mutually exclusive shapes) ----
export const isRequest = (m: RpcMessage): m is RpcRequest =>
  typeof m === 'object' && m !== null && 'method' in m && 'id' in m && 'params' in m;

export const isEvent = (m: RpcMessage): m is RpcEvent =>
  typeof m === 'object' && m !== null && 'event' in m && 'id' in m && 'payload' in m && !('method' in m);

export const isResult = (m: RpcMessage): m is RpcResult =>
  typeof m === 'object' && m !== null && 'result' in m && 'id' in m && !('method' in m) && !('event' in m);

// ---- serialization with validation ----
export const serialize = (m: RpcMessage): string => JSON.stringify(m);

export const parse = (raw: string): RpcMessage => {
  const decoded: unknown = JSON.parse(raw);
  if (
    typeof decoded !== 'object' || decoded === null ||
    !('id' in decoded) ||
    !('method' in decoded) && !('event' in decoded) && !('result' in decoded)
  ) {
    throw new Error('invalid rpc message: missing id or method/event/result');
  }
  if (isRequest(decoded as RpcMessage) || isEvent(decoded as RpcMessage) || isResult(decoded as RpcMessage)) {
    return decoded as RpcMessage;
  }
  throw new Error('invalid rpc message: could not classify');
};
