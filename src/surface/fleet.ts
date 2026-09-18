import { GovernanceClient } from '../rpc/client.js';

export interface FleetActor {
  id: string;
  tenantId?: string;
  scopes?: string[];
}

export interface FleetSession {
  id: string;
  workingDirectory: string;
  originalPrompt: string;
  actor?: FleetActor;
  status: 'idle' | 'running' | 'done' | 'maxLoops' | 'error';
  createdAt: string;
  updatedAt: string;
}

export interface FleetSessionStore {
  create(workingDirectory: string, originalPrompt: string, actor?: FleetActor): FleetSession;
  load(id: string): FleetSession | null;
  save(session: FleetSession): void;
  list(): FleetSession[];
  cleanOld(): void;
}

export class InMemoryFleetStore implements FleetSessionStore {
  #sessions = new Map<string, FleetSession>();
  #seq = 0;

  create(workingDirectory: string, originalPrompt: string, actor?: FleetActor): FleetSession {
    const id = `sess-${(++this.#seq).toString(36)}${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    const s: FleetSession = { id, workingDirectory, originalPrompt, actor, status: 'idle', createdAt: now, updatedAt: now };
    this.#sessions.set(id, s);
    return s;
  }

  load(id: string): FleetSession | null {
    return this.#sessions.get(id) ?? null;
  }

  save(session: FleetSession): void {
    this.#sessions.set(session.id, { ...session, updatedAt: new Date().toISOString() });
  }

  list(): FleetSession[] {
    return [...this.#sessions.values()];
  }

  cleanOld(): void {
    /* in-memory store: nothing to purge */
  }
}

export interface FleetOutcome {
  sessionId: string;
  type: 'done' | 'maxLoopsReached' | 'error';
  summary?: string;
  error?: string;
}

export interface SpawnedRun {
  sessionId: string;
  promise: Promise<FleetOutcome>;
}

/** Orchestrates many agent runs driven by a GovernanceClient, tracking them
 *  through a session store and exposing aggregate status. */
export class Fleet {
  #client: GovernanceClient;
  #store: FleetSessionStore;
  #active = new Map<string, Promise<FleetOutcome>>();

  constructor(client: GovernanceClient, store: FleetSessionStore) {
    this.#client = client;
    this.#store = store;
  }

  spawn(prompt: string, cwd: string, actor?: FleetActor, config?: Record<string, unknown>): SpawnedRun {
    const session = this.#store.create(cwd, prompt, actor);
    session.status = 'running';
    this.#store.save(session);

    const finish = (outcome: FleetOutcome): FleetOutcome => {
      session.status = outcome.type === 'error' ? 'error' : outcome.type === 'maxLoopsReached' ? 'maxLoops' : 'done';
      this.#store.save(session);
      this.#active.delete(session.id);
      return outcome;
    };

    const p = this.#client
      .run({ prompt, cwd, actor: actor ?? { id: 'anonymous' }, config, runId: session.id })
      .then((final: any) => {
        const r = final.result;
        const type: FleetOutcome['type'] =
          r.type === 'done' ? 'done' : r.type === 'maxLoopsReached' ? 'maxLoopsReached' : 'error';
        return finish({ sessionId: session.id, type, summary: r.summary, error: r.error });
      })
      .catch((e: Error): FleetOutcome => finish({ sessionId: session.id, type: 'error', error: e.message }));

    this.#active.set(session.id, p);
    return { sessionId: session.id, promise: p };
  }

  async waitForAll(): Promise<FleetOutcome[]> {
    return Promise.all([...this.#active.values()]);
  }

  running(): string[] {
    return [...this.#active.keys()];
  }

  status() {
    const all = this.#store.list();
    return {
      total: all.length,
      running: this.#active.size,
      done: all.filter((s) => s.status === 'done').length,
      maxLoops: all.filter((s) => s.status === 'maxLoops').length,
      error: all.filter((s) => s.status === 'error').length,
      sessions: all,
    };
  }

  sessions(): FleetSession[] {
    return this.#store.list();
  }

  load(id: string): FleetSession | null {
    return this.#store.load(id);
  }
}
