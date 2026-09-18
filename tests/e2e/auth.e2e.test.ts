// E2E tests for the auth cross-cutting feature, driven through the real
// Authenticator + ScimPrincipalResolver + HMAC token verifier. Deterministic:
// no LLM, no network.
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Authenticator } from '../../dist/auth/authenticator.js';
import { ScimPrincipalResolver, type ScimUser } from '../../dist/auth/scim.js';
import { verifyToken } from '../../dist/auth/token.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const USERS: ScimUser[] = [
  { id: 'u1', userName: 'alice', tenant: 'acme', displayName: 'Alice', groups: ['scope:read', 'scope:write', 'team-alpha'], roles: ['agent'] },
  { id: 'u2', userName: 'bob', tenant: 'acme', groups: ['scope:read'], roles: ['viewer'] },
];

describe('E2E: Auth (Authenticator + ScimPrincipalResolver)', () => {
  it('round-trips a token for a known user and resolves scopes/roles', () => {
    const resolver = new ScimPrincipalResolver(USERS);
    const auth = new Authenticator('s3cr3t', resolver);

    const token = auth.issue('u1');
    const res = auth.authenticate(token);
    assert.ok(res.ok);
    if (!res.ok) throw new Error('expected success');

    assert.strictEqual(res.principal.id, 'u1');
    assert.strictEqual(res.principal.tenant, 'acme');
    assert.ok(res.principal.roles.includes('agent'), 'roles should include agent');
    assert.ok(res.principal.scopes.includes('read'), 'scopes should include read');
    assert.ok(res.principal.scopes.includes('write'), 'scopes should include write');
    assert.ok(!res.principal.scopes.includes('team-alpha'), 'non-scope group should be ignored');
  });

  it('resolves an unknown user to an empty principal', () => {
    const resolver = new ScimPrincipalResolver(USERS);
    const auth = new Authenticator('s3cr3t', resolver);

    const token = auth.issue('nobody');
    const res = auth.authenticate(token);
    assert.ok(res.ok);
    if (!res.ok) throw new Error('expected success');

    assert.strictEqual(res.principal.id, 'nobody');
    assert.strictEqual(res.principal.tenant, '');
    assert.deepStrictEqual(res.principal.roles, []);
    assert.deepStrictEqual(res.principal.scopes, []);
  });

  it('rejects a token whose body has one character flipped', () => {
    const auth = new Authenticator('s3cr3t', new ScimPrincipalResolver(USERS));
    const token = auth.issue('u1');

    const dot = token.indexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const idx = Math.floor(body.length / 2);
    const ch = body[idx] === 'A' ? 'B' : 'A';
    const tampered = body.slice(0, idx) + ch + body.slice(idx + 1) + '.' + sig;

    const v = verifyToken(tampered, 's3cr3t');
    assert.strictEqual(v.ok, false);
    if (v.ok) throw new Error('expected failure');
    assert.strictEqual(v.reason, 'invalid signature');

    const a = auth.authenticate(tampered);
    assert.strictEqual(a.ok, false);
    if (a.ok) throw new Error('expected failure');
    assert.strictEqual(a.reason, 'invalid signature');
  });

  it('rejects a token with a truncated / corrupted signature', () => {
    const auth = new Authenticator('s3cr3t', new ScimPrincipalResolver(USERS));
    const token = auth.issue('u1');

    const dot = token.indexOf('.');
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    const truncated = body + '.' + sig.slice(0, Math.max(1, sig.length - 4));

    const v = verifyToken(truncated, 's3cr3t');
    assert.strictEqual(v.ok, false);
    if (v.ok) throw new Error('expected failure');
    assert.strictEqual(v.reason, 'invalid signature');

    const a = auth.authenticate(truncated);
    assert.strictEqual(a.ok, false);
    if (a.ok) throw new Error('expected failure');
    assert.strictEqual(a.reason, 'invalid signature');
  });

  it('rejects a token verified under the wrong secret', () => {
    const resolver = new ScimPrincipalResolver(USERS);
    const authA = new Authenticator('secretA', resolver);
    const authB = new Authenticator('secretB', resolver);

    const token = authA.issue('u1');
    const res = authB.authenticate(token);
    assert.strictEqual(res.ok, false);
    if (res.ok) throw new Error('expected failure');
    assert.strictEqual(res.reason, 'invalid signature');
  });

  it('rejects an already-expired token but accepts a fresh one', () => {
    const auth = new Authenticator('s3cr3t', new ScimPrincipalResolver(USERS));

    const expired = auth.issue('u1', { ttlMs: -1000 });
    const res = auth.authenticate(expired);
    assert.strictEqual(res.ok, false);
    if (res.ok) throw new Error('expected failure');
    assert.strictEqual(res.reason, 'token expired');

    const fresh = auth.issue('u1');
    const freshRes = auth.authenticate(fresh);
    assert.strictEqual(freshRes.ok, true);
    if (!freshRes.ok) throw new Error('expected success');
    assert.strictEqual(freshRes.principal.id, 'u1');
  });

  it('rejects a token once a short ttl elapses', async () => {
    const auth = new Authenticator('s3cr3t', new ScimPrincipalResolver(USERS));

    const token = auth.issue('u1', { ttlMs: 40 });
    await sleep(90);

    const res = auth.authenticate(token);
    assert.strictEqual(res.ok, false);
    if (res.ok) throw new Error('expected failure');
    assert.strictEqual(res.reason, 'token expired');
  });
});
