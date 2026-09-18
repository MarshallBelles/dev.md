import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  request, event, result, rpcError,
  startEvent, tokenEvent, usageEvent, toolEvent, doneEvent, maxLoopsEvent, errorEvent,
  isRequest, isEvent, isResult, serialize, parse,
  type RpcMessage,
} from '../dist/rpc/protocol.js';

describe('rpc factories (Phase 3a)', () => {
  it('builds a request', () => {
    assert.deepStrictEqual(request('1', 'run', { prompt: 'hi' }), { id: '1', method: 'run', params: { prompt: 'hi' } });
  });
  it('builds an event with payload', () => {
    assert.deepStrictEqual(event('1', 'token', { token: 'x' }), { id: '1', event: 'token', payload: { token: 'x' } });
  });
  it('builds a success result', () => {
    assert.deepStrictEqual(result('1', { ok: true }), { id: '1', result: { ok: true } });
  });
  it('builds an error result envelope', () => {
    assert.deepStrictEqual(rpcError('1', 400, 'bad'), { id: '1', result: { error: { code: 400, message: 'bad', data: undefined } } });
  });
});

describe('typed event builders (Phase 3a)', () => {
  it('startEvent', () => assert.deepStrictEqual(startEvent('r', '/tmp'), { id: 'r', event: 'start', payload: { runId: 'r', cwd: '/tmp' } }));
  it('tokenEvent', () => assert.deepStrictEqual(tokenEvent('r', 'ab'), { id: 'r', event: 'token', payload: { runId: 'r', token: 'ab' } }));
  it('usageEvent', () => assert.deepStrictEqual(usageEvent('r', 1, 2, 3), { id: 'r', event: 'usage', payload: { runId: 'r', promptTokens: 1, completionTokens: 2, total: 3 } }));
  it('toolEvent', () => assert.deepStrictEqual(toolEvent('r', 'WRITE_FILE', 'i', 'ok'), { id: 'r', event: 'tool', payload: { runId: 'r', tool: 'WRITE_FILE', input: 'i', result: 'ok' } }));
  it('doneEvent', () => assert.deepStrictEqual(doneEvent('r', 'done', true), { id: 'r', event: 'done', payload: { runId: 'r', summary: 'done', auditPassed: true } }));
  it('maxLoopsEvent', () => assert.deepStrictEqual(maxLoopsEvent('r', 5), { id: 'r', event: 'maxLoops', payload: { runId: 'r', maxLoops: 5 } }));
  it('errorEvent', () => assert.deepStrictEqual(errorEvent('r', 'boom'), { id: 'r', event: 'error', payload: { runId: 'r', message: 'boom' } }));
});

describe('message guards (Phase 3a)', () => {
  const req = request('1', 'run', {});
  const ev = event('1', 'token', {});
  const res = result('1', { ok: true });
  const msg = (x: unknown): RpcMessage => x as RpcMessage;

  it('classify a request', () => {
    assert.strictEqual(isRequest(msg(req)), true);
    assert.strictEqual(isEvent(msg(req)), false);
    assert.strictEqual(isResult(msg(req)), false);
  });
  it('classify an event', () => {
    assert.strictEqual(isRequest(msg(ev)), false);
    assert.strictEqual(isEvent(msg(ev)), true);
    assert.strictEqual(isResult(msg(ev)), false);
  });
  it('classify a result', () => {
    assert.strictEqual(isRequest(msg(res)), false);
    assert.strictEqual(isEvent(msg(res)), false);
    assert.strictEqual(isResult(msg(res)), true);
  });
});

describe('serialization (Phase 3a)', () => {
  it('round-trips a request', () => {
    const original = request('7', 'tool', { runId: 'r', toolName: 'WRITE_FILE', input: 'x' });
    assert.deepStrictEqual(parse(serialize(original)), original);
  });
  it('round-trips an event', () => {
    const original = event('7', 'done', { runId: 'r', summary: 's', auditPassed: true });
    assert.deepStrictEqual(parse(serialize(original)), original);
  });
  it('round-trips a result', () => {
    const original = result('7', { finished: true });
    assert.deepStrictEqual(parse(serialize(original)), original);
  });
  it('throws on a message missing id or a discriminator', () => {
    assert.throws(() => parse(JSON.stringify({ foo: 'bar' })), /invalid rpc message/);
    assert.throws(() => parse('not json'), SyntaxError);
  });
});
