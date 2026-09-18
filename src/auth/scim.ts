import type { Principal } from './principal.js';

export interface ScimUser {
  id: string;
  userName: string;
  tenant: string;
  displayName?: string;
  groups?: string[];       // SCIM groups; those matching scopePrefix become scopes
  roles?: string[];        // explicit SSO roles
}

export class ScimPrincipalResolver {
  #byId = new Map<string, ScimUser>();
  #scopePrefix: string;

  constructor(users: ScimUser[], scopePrefix: string = 'scope:') {
    this.#scopePrefix = scopePrefix;
    for (const u of users) this.#byId.set(u.id, u);
  }

  get(id: string): Principal | null {
    const u = this.#byId.get(id);
    return u ? this.resolve(u) : null;
  }

  users(): ScimUser[] {
    return [...this.#byId.values()];
  }

  resolve(user: ScimUser): Principal {
    const scopes = new Set<string>();
    for (const g of user.groups ?? []) {
      if (g.startsWith(this.#scopePrefix)) scopes.add(g.slice(this.#scopePrefix.length));
    }
    return {
      id: user.id,
      tenant: user.tenant,
      roles: user.roles ?? [],
      scopes: [...scopes],
      displayName: user.displayName,
    };
  }
}
