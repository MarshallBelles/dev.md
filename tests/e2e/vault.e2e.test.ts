// E2E tests for the vault cross-cutting feature, driven through the real
// InMemoryVault and FileVault. Deterministic.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { InMemoryVault, FileVault } from '../../dist/vault/vault.js';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('E2E: Vault (InMemory)', () => {
  it('reads a no-scope secret by anyone, even without a requester', () => {
    const v = new InMemoryVault();
    v.set('public', 'hello');

    assert.deepStrictEqual(v.get('public'), { ok: true, value: 'hello' });
    assert.deepStrictEqual(v.get('public', undefined), { ok: true, value: 'hello' });
    assert.deepStrictEqual(v.get('public', { id: 'x', scopes: [] }), { ok: true, value: 'hello' });
  });

  it('enforces scopes on a scoped secret', () => {
    const v = new InMemoryVault();
    v.set('db', 'p@ss', ['read']);

    assert.deepStrictEqual(v.get('db'), { ok: false, reason: 'insufficient scopes (requester required)' });
    assert.deepStrictEqual(v.get('db', { id: 'a', scopes: ['write'] }), { ok: false, reason: 'insufficient scopes' });
    assert.deepStrictEqual(v.get('db', { id: 'a', scopes: ['read'] }), { ok: true, value: 'p@ss' });
  });

  it('expires and removes a secret; expireIn returns false for missing keys', () => {
    const v = new InMemoryVault();
    v.set('k', 'v');

    assert.strictEqual(v.expireIn('k', -1000), true);
    assert.deepStrictEqual(v.get('k'), { ok: false, reason: 'expired' });
    assert.ok(!v.list().includes('k'), 'expired secret must be removed from the list');

    assert.strictEqual(v.expireIn('does-not-exist', -1000), false);
  });

  it('destroys a secret (idempotently) then reports no secret', () => {
    const v = new InMemoryVault();
    v.set('k', 'v');

    assert.strictEqual(v.destroy('k'), true);
    assert.strictEqual(v.destroy('k'), false);
    assert.deepStrictEqual(v.get('k'), { ok: false, reason: 'no secret' });
  });
});

describe('E2E: Vault (File)', () => {
  let dir: string;
  let path: string;

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'vault-'));
    path = join(dir, 'secrets.json');
    // Pre-seed an on-disk secret so FileVault can be shown to load from disk.
    writeFileSync(path, JSON.stringify({ secrets: [{ key: 'seed', value: 'seedval', scopes: [] }] }), 'utf-8');
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('persists secrets to disk and reloads them into a new instance', () => {
    const v1 = new FileVault(path);
    assert.deepStrictEqual(v1.list(), ['seed'], 'loads pre-seeded secret from disk');
    assert.deepStrictEqual(v1.get('seed'), { ok: true, value: 'seedval' });

    v1.set('a', '1');
    v1.set('b', '2', ['read']);

    // The on-disk shape must be { secrets: [...] }.
    const onDisk = JSON.parse(readFileSync(path, 'utf-8'));
    assert.ok(Array.isArray(onDisk.secrets), 'file must expose a secrets array');
    assert.deepStrictEqual(onDisk.secrets.map((e: { key: string }) => e.key).sort(), ['a', 'b', 'seed']);

    // A brand-new instance over the same file sees the persisted keys.
    const v2 = new FileVault(path);
    assert.deepStrictEqual(v2.list().sort(), ['a', 'b', 'seed']);
    assert.deepStrictEqual(v2.get('a'), { ok: true, value: '1' });
    assert.deepStrictEqual(v2.get('b', { id: 'r', scopes: ['read'] }), { ok: true, value: '2' });

    // Destroy via another instance, confirm it is gone after a fresh reload.
    const v3 = new FileVault(path);
    assert.strictEqual(v3.destroy('a'), true);
    assert.strictEqual(v3.destroy('a'), false);

    const v4 = new FileVault(path);
    assert.ok(!v4.list().includes('a'), 'destroyed secret must not persist');
    assert.deepStrictEqual(v4.get('a'), { ok: false, reason: 'no secret' });
    assert.deepStrictEqual(v4.list().sort(), ['b', 'seed']);
  });
});
