import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { GovernanceEngine, type ServerOptions } from './engine.js';
import { parse, serialize, rpcError, type RpcMessage, type RpcRequest } from './protocol.js';

/** Build an http.Server that speaks the dev-md RPC protocol (newline-delimited
 *  JSON messages). Each POST is handled by the engine; events stream out as
 *  they happen and a final result message terminates the response. */
export const createGovernedServer = (options?: ServerOptions) => {
  const engine = new GovernanceEngine(options);

  return createHttpServer(async (input: IncomingMessage, res: ServerResponse) => {
    let body = '';
    for await (const chunk of input) body += chunk as string;

    let req: RpcRequest;
    try {
      const decoded = parse(body);
      if (typeof decoded !== 'object' || decoded === null || !('method' in decoded)) {
        throw new Error('not a request');
      }
      req = decoded as RpcRequest;
    } catch (e) {
      res.setHeader('Content-Type', 'application/json');
      res.end(serialize(rpcError('0', 400, `bad request: ${(e as Error).message}`)));
      return;
    }

    const messages: RpcMessage[] = [];
    const send = (m: RpcMessage) => { messages.push(m); };
    try {
      const final = await engine.handle(req, send);
      res.setHeader('Content-Type', 'application/json');
      for (const m of messages) res.write(serialize(m) + '\n');
      res.write(serialize(final) + '\n');
    } catch (e) {
      res.write(serialize(rpcError('0', 500, (e as Error).message)) + '\n');
    } finally {
      res.end();
    }
  });
};
