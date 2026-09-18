export interface Principal {
  id: string;
  tenant: string;
  roles: string[];   // SSO roles, e.g. ['admin', 'agent']
  scopes: string[];  // resolved from SCIM groups, e.g. ['read', 'write']
  displayName?: string;
}
