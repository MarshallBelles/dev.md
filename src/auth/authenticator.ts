import { createToken, verifyToken, type TokenVerification } from './token.js';
import { ScimPrincipalResolver } from './scim.js';
import type { Principal } from './principal.js';

export interface TokenOptions {
  ttlMs?: number;
}

export class Authenticator {
  #secret: string;
  #resolver: ScimPrincipalResolver;

  constructor(secret: string, resolver: ScimPrincipalResolver) {
    this.#secret = secret;
    this.#resolver = resolver;
  }

  /** Issue a signed token for a user known to the SCIM directory (or an unknown
   *  user, who resolves to an empty principal). */
  issue(userId: string, opts: TokenOptions = {}): string {
    const principal = this.#resolver.get(userId) ?? { id: userId, tenant: '', roles: [], scopes: [] };
    const payload: Record<string, unknown> = {
      sub: principal.id,
      tenant: principal.tenant,
      roles: principal.roles,
      scopes: principal.scopes,
      iat: Date.now(),
    };
    if (opts.ttlMs !== undefined) payload.exp = Date.now() + opts.ttlMs;
    return createToken(payload, this.#secret);
  }

  /** Verify a token and return its principal. */
  authenticate(token: string): { ok: true; principal: Principal } | { ok: false; reason: string } {
    const v: TokenVerification = verifyToken(token, this.#secret);
    if (!v.ok) return v;
    const payload = v.payload;
    if (typeof payload.exp === 'number' && Date.now() > payload.exp) {
      return { ok: false, reason: 'token expired' };
    }
    return {
      ok: true,
      principal: {
        id: payload.sub as string,
        tenant: (payload.tenant as string) ?? '',
        roles: (payload.roles as string[]) ?? [],
        scopes: (payload.scopes as string[]) ?? [],
      },
    };
  }
}
