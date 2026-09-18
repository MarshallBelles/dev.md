// E2E: BatchRunner against the REAL governed microservice + REAL local LLM.
//
// Two of the three prompts exercise the real LLM (and must succeed); the third
// is a deterministic failure. The failure cannot be produced reliably through
// the real LLM itself: empirical runs showed that the well-behaved model simply
// refuses a denied command (e.g. `sudo ...`) and reports DONE, which BatchRunner
// tallies as a SUCCESS. The only prompt-independent, fast, deterministic
// failure is to route the run at an unreachable endpoint, which makes
// streamCompletion throw before any LLM reasoning. Because the agent's network
// call resolves its endpoint via loadConfig() (the HOME-redirected config.json
// installed by startGovernedServer) - not via the inline run config - isolating
// that one prompt requires temporarily pointing HOME at a dead-endpoint config,
// exactly as the shared harness does internally.
//
// Because a single run() call shares one process HOME (hence one endpoint), the
// batch is run in two phases: [A, B] against the real LLM, then [C] against a
// dead endpoint. Their results are combined into one report.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceClient } from '../../dist/rpc/client.js';
import { BatchRunner, type BatchStepResult } from '../../dist/surface/ci.js';
import { startGovernedServer, makeTempCwd, realLlmConfig } from './server-utils.js';

// Redirect HOME/APPDATA/XDG_CONFIG_HOME at a throwaway config dir whose
// config.json points at a port nothing listens on, so the real agent loop's
// streamCompletion fails fast (no LLM) and the run errors deterministically.
const startDeadConfigHome = () => {
  const base = `/tmp/dev-md-e2e-dead-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const cfgDir = join(base, 'Library', 'Application Support', 'dev-agent');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(
    join(cfgDir, 'config.json'),
    JSON.stringify({
      apiUrl: 'http://127.0.0.1:1/v1',
      model: 'mars',
      apiKey: '',
      maxTokens: 4096,
      maxContextTokens: 131072,
      commandGuardEnabled: true,
      maxApiRetries: 1,
      apiRetryWindow: 5,
      requestTimeout: 2,
      maxRetriesAutomated: 1,
    })
  );
  const prev = {
    HOME: process.env.HOME,
    APPDATA: process.env.APPDATA,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  };
  process.env.HOME = base;
  process.env.APPDATA = base;
  process.env.XDG_CONFIG_HOME = base;
  return {
    close: () => {
      rmSync(base, { recursive: true, force: true });
      process.env.HOME = prev.HOME;
      process.env.APPDATA = prev.APPDATA;
      process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME;
    },
  };
};

describe('E2E: BatchRunner (real governed microservice + real LLM)', () => {
  let client: GovernanceClient;
  let server: { baseUrl: string; close: () => Promise<void> };
  let cwds: string[] = [];

  beforeEach(async () => {
    server = await startGovernedServer();
    client = new GovernanceClient(server.baseUrl);
  });

  afterEach(async () => {
    await server.close();
    for (const d of cwds) rmSync(d, { recursive: true, force: true });
    cwds = [];
  });

  it('runs a mixed batch: 2 real-LLM successes and 1 deterministic failure', async () => {
    const steps: BatchStepResult[] = [];
    const onStep = (r: BatchStepResult) => steps.push(r);

    const cwdA = makeTempCwd();
    const cwdB = makeTempCwd();
    cwds.push(cwdA, cwdB);

    // Phase 1: the two real-LLM prompts, run concurrently (concurrency 2).
    const reportAB = await new BatchRunner(client, { concurrency: 2 }).run(
      [
        { label: 'write-file', prompt: 'Create a file named ci-a.txt containing exactly the text ci-a-ok and report success.', cwd: cwdA, config: realLlmConfig() },
        { label: 'reply-ok', prompt: 'Reply with exactly the single word ok.', cwd: cwdB, config: realLlmConfig() },
      ],
      onStep
    );

    // Phase 2: the guaranteed-fail prompt, isolated to a dead endpoint so it
    // errors fast and independently of the model's judgment.
    const cwdC = makeTempCwd();
    cwds.push(cwdC);
    const dead = startDeadConfigHome();
    const reportC = await new BatchRunner(client).run(
      [
        { label: 'unreachable', prompt: 'Create a file named ci-c.txt containing exactly the text ci-c-ok and report success.', cwd: cwdC, config: realLlmConfig() },
      ],
      onStep
    );
    dead.close();

    const report = {
      total: reportAB.total + reportC.total,
      succeeded: reportAB.succeeded + reportC.succeeded,
      failed: reportAB.failed + reportC.failed,
      steps,
    };

    assert.strictEqual(report.total, 3, 'combined report should cover all 3 prompts');
    assert.strictEqual(report.succeeded, 2, 'two prompts should succeed');
    assert.strictEqual(report.failed, 1, 'one prompt should fail');
    assert.strictEqual(steps.length, 3, 'onStep should have fired once per prompt');

    const doneSteps = steps.filter((s) => s.outcome?.type === 'done');
    const failedStep = steps.find((s) => s.outcome?.type !== 'done');
    assert.ok(doneSteps.length === 2, 'exactly two steps should resolve to done');
    assert.ok(failedStep, 'one step should not resolve to done');
    // The unreachable-endpoint run never reaches the model, so its outcome is
    // not 'done' (BatchRunner tallies succeeded only for type === 'done').
    assert.strictEqual(failedStep?.outcome?.type, undefined, 'the failed step should not have completed');
    assert.strictEqual(failedStep?.error, undefined, 'the rpc-error path does not populate BatchRunner.error');

    // Ground truth: prompt A actually wrote its file on disk.
    const content = existsSync(join(cwdA, 'ci-a.txt')) ? readFileSync(join(cwdA, 'ci-a.txt'), 'utf-8') : null;
    assert.ok(content !== null, 'ci-a.txt should exist on disk');
    assert.ok(content?.includes('ci-a-ok'), `ci-a.txt should contain the requested text, got: ${content}`);
  });
});
