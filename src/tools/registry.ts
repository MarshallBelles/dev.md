import type { ToolAdapter, ToolCapability } from './adapter.js';

/**
 * A name-keyed collection of tool adapters. Surfaces and governance look tools
 * up by name; the engine resolves a ToolName to an adapter through this.
 */
export class ToolRegistry {
  #adapters: Map<string, ToolAdapter>;

  constructor() {
    this.#adapters = new Map();
  }

  /** Register an adapter. Throws if the name is already taken. Returns this for chaining. */
  register(adapter: ToolAdapter): this {
    if (this.#adapters.has(adapter.metadata.name)) {
      throw new Error(`Tool already registered: ${adapter.metadata.name}`);
    }
    this.#adapters.set(adapter.metadata.name, adapter);
    return this;
  }

  /** Whether an adapter is registered under a name. */
  has(name: string): boolean {
    return this.#adapters.has(name);
  }

  /** Look up a registered adapter by name, or undefined. */
  get(name: string): ToolAdapter | undefined {
    return this.#adapters.get(name);
  }

  /** All registered adapters, in insertion order. */
  list(): ToolAdapter[] {
    return [...this.#adapters.values()];
  }

  /** Adapters that declare a capability, in insertion order. */
  listByCapability(capability: ToolCapability): ToolAdapter[] {
    return this.list().filter(a => a.metadata.capabilities.includes(capability));
  }

  /** Total number of registered adapters. */
  get size(): number {
    return this.#adapters.size;
  }
}

/** Factory for a fresh, empty registry. */
export const createRegistry = (): ToolRegistry => new ToolRegistry();
