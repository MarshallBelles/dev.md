import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createGovernedServer } from '../dist/rpc/server.js';
import { request, serialize, parse, isResult, RpcMessage } from '../dist/rpc/protocol.js';

describe('rpc microservice HTTP (Phase 3b)', () => {
  it('list_tools returns the governed tool catalog over a real socket', async () => {
    const server = createGovernedServer();
    const address: any = await new Promise((resolve) => server.listen(0, () => resolve(server.address())));
    const port = address.port;
    try {
      const res = await fetch(`http://localhost:${port}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serialize(request('h1', 'list_tools', {})),
        signal: AbortSignal.timeout(5000),
      });
      const text = await res.text();
      const msgs: RpcMessage[] = text.split('\n').filter(Boolean).map((l) => parse(l));
      const r = msgs.find((m) => isResult(m));
      assert.ok(r, 'a result message should be present');
      const tools = (r as any).result.tools;
      assert.ok(tools.some((t: any) => t.name === 'WRITE_FILE'));
      assert.ok(tools.some((t: any) => t.name === 'READ_FILE'));
      assert.ok(tools.some((t: any) => t.name === 'COMMAND'));
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
