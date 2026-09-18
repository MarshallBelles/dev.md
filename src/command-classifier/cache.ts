export type CacheVerdict = 'ACCEPT' | 'BLOCK';

export interface CacheEntry {
  verdict: CacheVerdict;
  reason: string;
}

/** Minimal short-lived cache keyed by (cwd + command). TTL is in milliseconds;
 * entries expire lazily on read. */
export interface ClassifierCache {
  get(key: string): CacheEntry | undefined;
  set(key: string, verdict: CacheVerdict, reason: string, ttlMs: number): void;
  clear(): void;
}

export const createTtlCache = (): ClassifierCache => {
  const expiresAt = new Map<string, number>();
  const entries = new Map<string, CacheEntry>();
  return {
    get(key) {
      const exp = expiresAt.get(key);
      if (exp === undefined) return undefined;
      if (Date.now() > exp) {
        expiresAt.delete(key);
        entries.delete(key);
        return undefined;
      }
      return entries.get(key);
    },
    set(key, verdict, reason, ttlMs) {
      expiresAt.set(key, Date.now() + ttlMs);
      entries.set(key, { verdict, reason });
    },
    clear() {
      expiresAt.clear();
      entries.clear();
    },
  };
};
