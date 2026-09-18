import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createToken, verifyToken } from '../dist/auth/token.js';
import { ScimPrincipalResolver } from '../dist/auth/scim.js';
import { Authenticator } from '../dist/auth/authenticator.js';
import type { ScimUser } from '../dist/auth/scim.js';

const secret = 'test-secret';
const users: ScimUser[] = [
  { id: 'u1', userName: 'alice', tenant: 'acme', displayName: 'Alice', groups: ['scope:read', 'scope:write', 'team-alpha'], roles: ['agent'] },
  { id: 'u2', userName: 'bob', tenant: 'acme', groups: ['scope:read'], roles: ['viewer'] },
];

describe('token (Phase 5a)', () => {
  it('round-trips a token', () => {
    const token = createToken({ sub: 'u1', scopes: ['read'] }, secret);
    const v = verifyToken(token, secret);
    assert.deepStrictEqual(v, { ok: true, payload: { sub: 'u1', scopes: ['read'] } });
  });
  it('rejects a tampered body', () => {
    const token = createToken({ sub: 'u1' }, secret);
    const tampered = token.slice(0, -2) + (token.endsWith('AA') ? 'BB' : 'AA');
    const v = verifyToken(tampered, secret);
    assert.strictEqual(v.ok, false);
  });
  it('rejects a token signed with a different secret', () => {
    const token = createToken({ sub: 'u1' }, secret);
    assert.strictEqual(verifyToken(token, 'other').ok, false);
  });
  it('rejects a malformed token', () => {
    assert.strictEqual(verifyToken('no-dot', secret).ok, false);
    assert.strictEqual(verifyToken('', secret).ok, false);
  });
});

describe('ScimPrincipalResolver (Phase 5a)', () => {
  const resolver = new ScimPrincipalResolver(users);
  it('resolves groups through the scope prefix', () => {
    const p = resolver.get('u1')!;
    assert.strictEqual(p.tenant, 'acme');
    assert.deepStrictEqual(p.roles, ['agent']);
    assert.deepStrictEqual(p.scopes, ['read', 'write']); // 'team-alpha' is not scoped, ignored
  });
  it('resolves a single-scope user', () => {
    const p = resolver.get('u2')!;
    assert.deepStrictEqual(p.scopes, ['read']);
  });
  it('returns null for an unknown id', () => {
    assert.strictEqual(resolver.get('nope'), null);
  });
});

describe('Authenticator (Phase 5a)', () => {
  const auth = new Authenticator(secret, new ScimPrincipalResolver(users));

  it('issues and authenticates a token', () => {
    const token = auth.issue('u1');
    const r = auth.authenticate(token);
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.principal.id, 'u1');
      assert.strictEqual(r.principal.tenant, 'acme');
      assert.deepStrictEqual(r.principal.scopes, ['read', 'write']);
    }
  });
  it('rejects an invalid token', () => {
    assert.strictEqual(auth.authenticate('garbage').ok, false);
    assert.strictEqual(auth.authenticate(createToken({ sub: 'x' }, 'wrong')).ok, false);
  });
  it('rejects an expired token', () => {
    const token = auth.issue('u1', { ttlMs: -1 }); // already expired
    const r = auth.authenticate(token);
    assert.strictEqual(r.ok, false);
  });
  it('issues a principal for an unknown user (empty scopes)', () => {
    const token = auth.issue('stranger');
    const r = auth.authenticate(token);
    assert.strictEqual(r.ok, true);
    if (r.ok) {
      assert.strictEqual(r.principal.id, 'stranger');
      assert.deepStrictEqual(r.principal.scopes, []);
    }
  });
});
