import { describe, it, after } from 'node:test';
import assert from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryVault, FileVault } from '../dist/vault/vault.js';

const req = (scopes: string[]) => ({ id: 'op', scopes });

const tmpDir = mkdtempSync(join(tmpdir(), 'dev-md-vault-'));
after(() => rmSync(tmpDir, { recursive: true, force: true }));

describe('InMemoryVault (Phase 5b)', () => {
  it('sets and gets a secret', () => {
    const v = new InMemoryVault();
    v.set('api_key', 'secret123');
    const r = v.get('api_key');
    assert.deepStrictEqual(r, { ok: true, value: 'secret123' });
  });
  it('fails on a missing key', () => {
    const v = new InMemoryVault();
    assert.deepStrictEqual(v.get('nope'), { ok: false, reason: 'no secret' });
  });
  it('enforces scopes: requires a requester when restricted', () => {
    const v = new InMemoryVault();
    v.set('restricted', 'x', ['admin']);
    assert.deepStrictEqual(v.get('restricted'), { ok: false, reason: 'insufficient scopes (requester required)' });
    assert.deepStrictEqual(v.get('restricted', req(['viewer'])), { ok: false, reason: 'insufficient scopes' });
    assert.deepStrictEqual(v.get('restricted', req(['admin'])), { ok: true, value: 'x' });
  });
  it('allows unrestricted secrets without a requester', () => {
    const v = new InMemoryVault();
    v.set('public', 'p');
    assert.deepStrictEqual(v.get('public'), { ok: true, value: 'p' });
  });
  it('expires secrets', () => {
    const v = new InMemoryVault();
    v.set('ephemeral', 'y');
    v.expireIn('ephemeral', -1); // already expired
    assert.deepStrictEqual(v.get('ephemeral'), { ok: false, reason: 'expired' });
  });
  it('destroys and lists secrets', () => {
    const v = new InMemoryVault();
    v.set('a', '1');
    v.set('b', '2');
    assert.deepStrictEqual(v.list().sort(), ['a', 'b']);
    assert.strictEqual(v.destroy('a'), true);
    assert.strictEqual(v.destroy('a'), false);
    assert.deepStrictEqual(v.list(), ['b']);
  });
});

describe('FileVault (Phase 5b)', () => {
  it('persists across instances', () => {
    const path = join(tmpDir, 'vault.json');
    const v1 = new FileVault(path);
    v1.set('db_password', 'hunter2', ['admin']);
    const v2 = new FileVault(path);
    const r = v2.get('db_password', req(['admin']));
    assert.deepStrictEqual(r, { ok: true, value: 'hunter2' });
    assert.deepStrictEqual(v2.list(), ['db_password']);
  });
  it('enforces scopes and expiry on disk', () => {
    const path = join(tmpDir, 'vault2.json');
    const v = new FileVault(path);
    v.set('tok', 't', ['reader']);
    assert.deepStrictEqual(v.get('tok'), { ok: false, reason: 'insufficient scopes (requester required)' });
    v.expireIn('tok', -1);
    assert.deepStrictEqual(v.get('tok', req(['reader'])), { ok: false, reason: 'expired' });
  });
});
