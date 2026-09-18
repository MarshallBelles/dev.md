import { GovernanceClient } from '../rpc/client.js';

export interface BatchPrompt {
  label?: string;
  prompt: string;
  cwd: string;
  actor?: { id: string; scopes?: string[]; tenantId?: string };
  config?: Record<string, unknown>;
}

export interface BatchStepResult {
  label: string;
  prompt: string;
  outcome: { type: string; summary?: string; errored: boolean } | null;
  error?: string;
}

export interface BatchReport {
  total: number;
  succeeded: number;
  failed: number;
  steps: BatchStepResult[];
}

/** Runs a batch of prompts through a GovernanceClient (typically a remote
 *  microservice) for CI. Processes with bounded concurrency; a failing prompt
 *  does not abort the batch. */
export class BatchRunner {
  #client: GovernanceClient;
  #concurrency: number;

  constructor(client: GovernanceClient, opts: { concurrency?: number } = {}) {
    this.#client = client;
    this.#concurrency = Math.max(1, opts.concurrency ?? 1);
  }

  async run(prompts: BatchPrompt[], onStep?: (r: BatchStepResult) => void): Promise<BatchReport> {
    const steps: BatchStepResult[] = [];
    let cursor = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const idx = cursor++;
        if (idx >= prompts.length) return;
        const p = prompts[idx];
        const label = p.label ?? `prompt-${idx + 1}`;
        try {
          const final = await this.#client.run({
            prompt: p.prompt,
            cwd: p.cwd,
            actor: p.actor ?? { id: 'anonymous' },
            config: p.config,
          });
          const result = (final as any).result;
          const step: BatchStepResult = {
            label,
            prompt: p.prompt,
            outcome: { type: result?.type, summary: result?.summary, errored: result?.type === 'error' },
          };
          steps.push(step);
          onStep?.(step);
        } catch (e) {
          const step: BatchStepResult = { label, prompt: p.prompt, outcome: null, error: (e as Error).message };
          steps.push(step);
          onStep?.(step);
        }
      }
    };

    const workers = Array.from(
      { length: Math.min(this.#concurrency, Math.max(prompts.length, 1)) },
      () => worker()
    );
    await Promise.all(workers);

    const succeeded = steps.filter((s) => s.outcome?.type === 'done').length;
    return { total: steps.length, succeeded, failed: steps.length - succeeded, steps };
  }

  static summary(report: BatchReport): string {
    return `${report.succeeded}/${report.total} succeeded, ${report.failed} failed`;
  }
}
