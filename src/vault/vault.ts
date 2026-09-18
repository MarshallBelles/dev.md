import { readFileSync, writeFileSync } from 'node:fs';

export interface SecretEntry {
  key: string;
  value: string;
  scopes: string[]; // empty = no access restriction
  expiresAt?: number; // epoch ms
}

export interface SecretRequester {
  id: string;
  scopes: string[];
}

export interface Vault {
  set(key: string, value: string, scopes?: string[]): void;
  expireIn(key: string, ttlMs: number): boolean;
  get(key: string, requester?: SecretRequester): { ok: true; value: string } | { ok: false; reason: string };
  destroy(key: string): boolean;
  list(): string[];
}

export class InMemoryVault implements Vault {
  #store = new Map<string, SecretEntry>();

  set(key: string, value: string, scopes: string[] = []): void {
    this.#store.set(key, { key, value, scopes });
  }

  expireIn(key: string, ttlMs: number): boolean {
    const e = this.#store.get(key);
    if (!e) return false;
    e.expiresAt = Date.now() + ttlMs;
    return true;
  }

  get(key: string, requester?: SecretRequester): { ok: true; value: string } | { ok: false; reason: string } {
    const e = this.#store.get(key);
    if (!e) return { ok: false, reason: 'no secret' };
    if (e.expiresAt !== undefined && Date.now() > e.expiresAt) {
      this.#store.delete(key);
      return { ok: false, reason: 'expired' };
    }
    if (e.scopes.length > 0) {
      if (!requester) return { ok: false, reason: 'insufficient scopes (requester required)' };
      if (!e.scopes.some((s) => requester.scopes.includes(s))) return { ok: false, reason: 'insufficient scopes' };
    }
    return { ok: true, value: e.value };
  }

  destroy(key: string): boolean {
    return this.#store.delete(key);
  }

  list(): string[] {
    return [...this.#store.keys()];
  }
}

export class FileVault implements Vault {
  #path: string;
  #store: Map<string, SecretEntry>;

  constructor(path: string) {
    this.#path = path;
    this.#store = this.#load();
  }

  #load(): Map<string, SecretEntry> {
    const map = new Map<string, SecretEntry>();
    try {
      const raw = readFileSync(this.#path, 'utf-8');
      const parsed = JSON.parse(raw);
      const entries: SecretEntry[] = Array.isArray(parsed?.secrets) ? parsed.secrets : [];
      for (const e of entries) map.set(e.key, e);
    } catch {
      /* absent / corrupt file -> start empty */
    }
    return map;
  }

  #persist(): void {
    writeFileSync(this.#path, JSON.stringify({ secrets: [...this.#store.values()] }, null, 2));
  }

  set(key: string, value: string, scopes: string[] = []): void {
    this.#store.set(key, { key, value, scopes });
    this.#persist();
  }

  expireIn(key: string, ttlMs: number): boolean {
    const e = this.#store.get(key);
    if (!e) return false;
    e.expiresAt = Date.now() + ttlMs;
    this.#persist();
    return true;
  }

  get(key: string, requester?: SecretRequester): { ok: true; value: string } | { ok: false; reason: string } {
    const e = this.#store.get(key);
    if (!e) return { ok: false, reason: 'no secret' };
    if (e.expiresAt !== undefined && Date.now() > e.expiresAt) {
      this.#store.delete(key);
      this.#persist();
      return { ok: false, reason: 'expired' };
    }
    if (e.scopes.length > 0) {
      if (!requester) return { ok: false, reason: 'insufficient scopes (requester required)' };
      if (!e.scopes.some((s) => requester.scopes.includes(s))) return { ok: false, reason: 'insufficient scopes' };
    }
    return { ok: true, value: e.value };
  }

  destroy(key: string): boolean {
    const existed = this.#store.delete(key);
    this.#persist();
    return existed;
  }

  list(): string[] {
    return [...this.#store.keys()];
  }
}
