export type PdpVerdict = 'allow' | 'deny' | 'exception';

export interface PolicyCondition {
  /** JSON pointer into the policy input, e.g. '/actor/id', '/capabilities/0'. */
  path: string;
  op: 'eq' | 'ne' | 'in' | 'not_in' | 'exists' | 'gte' | 'lte';
  value?: unknown;
}

export interface PolicyRule {
  name: string;
  /** All conditions must match (logical AND). Empty = always matches. */
  conditions: PolicyCondition[];
  verdict: PdpVerdict;
}

export interface PolicyDocument {
  id: string;
  label?: string;
  rules: PolicyRule[];
}

export interface PdpDecision {
  verdict: PdpVerdict;
  rule?: string;
  reason?: string;
}

const resolvePath = (obj: unknown, path: string): { found: boolean; value: unknown } => {
  let cur: any = obj;
  for (const part of path.split('/').filter(Boolean)) {
    if (cur == null) return { found: false, value: undefined };
    cur = cur[part];
  }
  return { found: cur !== undefined && cur !== null, value: cur };
};

const matches = (input: unknown, conditions: PolicyCondition[]): boolean =>
  conditions.every((c) => {
    const { found, value } = resolvePath(input, c.path);
    switch (c.op) {
      case 'exists':
        return found;
      case 'eq':
        return found && value === c.value;
      case 'ne':
        return !found || value !== c.value;
      case 'in':
        return found && Array.isArray(c.value) && (c.value as unknown[]).includes(value);
      case 'not_in':
        return !found || !Array.isArray(c.value) || !(c.value as unknown[]).includes(value);
      case 'gte':
        return found && Number(value) >= Number(c.value);
      case 'lte':
        return found && Number(value) <= Number(c.value);
      default:
        return false;
    }
  });

/** A small, dependency-free policy-decision point. Policies are JSON documents;
 *  rules are evaluated in order and the first match wins; otherwise default-deny. */
export class PolicyDecisionPoint {
  #docs = new Map<string, PolicyDocument>();
  constructor(docs: PolicyDocument[] = []) {
    for (const d of docs) this.#docs.set(d.id, d);
  }
  addDocument(doc: PolicyDocument): this {
    this.#docs.set(doc.id, doc);
    return this;
  }
  hasDocument(id: string): boolean {
    return this.#docs.has(id);
  }
  listDocuments(): string[] {
    return [...this.#docs.keys()];
  }
  decision(docId: string, input: unknown): PdpDecision {
    const doc = this.#docs.get(docId);
    if (!doc) return { verdict: 'deny', reason: `no policy document '${docId}' (default-deny)` };
    for (const rule of doc.rules) {
      if (matches(input, rule.conditions)) {
        return { verdict: rule.verdict, rule: rule.name };
      }
    }
    return { verdict: 'deny', reason: 'no rule matched (default-deny)' };
  }
}
