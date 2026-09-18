// E2E: Fleet orchestrator against the REAL governed microservice + REAL local LLM.
//
// Three runs are spawned concurrently: two real-LLM runs that create files and
// resolve 'done', and one run that must fail. As with the BatchRunner e2e, a
// deterministic failure cannot come from the real LLM itself: the well-behaved
// model refuses denied commands and reports DONE (a success). The only
// prompt-independent failure is routing a run at an unreachable endpoint, which
// makes the agent's streamCompletion throw before any LLM reasoning. Because
// the network endpoint is resolved via the HOME-redirected config.json (installed
// by startGovernedServer), that one failing run is isolated by pointing HOME at a
// dead-endpoint config.
//
// To avoid the process-global HOME racing with an in-flight real-LLM run, the
// failing run is spawned first (under the dead config) and awaited to completion
// before HOME is restored and the two real-LLM runs are spawned.
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { existsSync, readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { GovernanceClient } from '../../dist/rpc/client.js';
import { Fleet, InMemoryFleetStore } from '../../dist/surface/fleet.js';
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

describe('E2E: Fleet orchestrator (real governed microservice + real LLM)', () => {
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

  it('spawns concurrent runs: 2 real-LLM done runs and 1 deterministic error', async () => {
    const fleet = new Fleet(client, new InMemoryFleetStore());

    // Phase 1: the guaranteed-fail run, isolated to a dead endpoint. Spawned
    // first and awaited to completion so its network call is fully resolved
    // against the dead config before HOME is pointed back at the real LLM.
    const cwdFail = makeTempCwd();
    cwds.push(cwdFail);
    const dead = startDeadConfigHome();
    const failRun = fleet.spawn(
      'Create a file named fl-fail.txt containing exactly the text fl-fail-ok and report success.',
      cwdFail,
      { id: 'e2e' },
      realLlmConfig()
    );
    const failOutcome = await failRun.promise;
    dead.close();

    // Phase 2: the two real-LLM runs (real endpoint restored) → both 'done'.
    const cwdX = makeTempCwd();
    const cwdY = makeTempCwd();
    cwds.push(cwdX, cwdY);
    const runX = fleet.spawn(
      'Create a file named fl-x.txt containing exactly the text fl-x-ok and report success.',
      cwdX,
      { id: 'e2e' },
      realLlmConfig()
    );
    const runY = fleet.spawn(
      'Create a file named fl-y.txt containing exactly the text fl-y-ok and report success.',
      cwdY,
      { id: 'e2e' },
      realLlmConfig()
    );

    // failRun already resolved (and was removed from the active set), so its
    // outcome is folded in alongside the two real-LLM runs that waitForAll awaits.
    const outcomes = [failOutcome, ...(await fleet.waitForAll())];

    assert.strictEqual(outcomes.length, 3, 'all three runs should resolve');
    const types = outcomes.map((o) => o.type).sort();
    assert.deepStrictEqual(types, ['done', 'done', 'error'], 'two done and one error');

    assert.strictEqual(failOutcome.type, 'error', 'the isolated run should resolve as an error');
    assert.ok(failOutcome.error, 'the error outcome should carry a message');

    // Fleet aggregate status reflects the completed runs.
    const st = fleet.status();
    assert.strictEqual(st.total, 3, 'fleet should track 3 sessions');
    assert.strictEqual(st.done, 2, 'two sessions should be done');
    assert.strictEqual(st.error, 1, 'one session should be an error');
    assert.strictEqual(st.running, 0, 'no runs should still be running');

    // Session store: 3 sessions, each with a matching status, and load() works.
    const sessions = fleet.sessions();
    assert.strictEqual(sessions.length, 3, 'session store should hold 3 sessions');
    for (const o of outcomes) {
      const expectedStatus = o.type === 'done' ? 'done' : 'error';
      const sess = fleet.load(o.sessionId);
      assert.ok(sess, `session ${o.sessionId} should be loadable`);
      assert.strictEqual(sess?.status, expectedStatus, `session ${o.sessionId} status should be ${expectedStatus}`);
    }

    // Ground truth: both real-LLM runs wrote their files on disk.
    const contentX = existsSync(join(cwdX, 'fl-x.txt')) ? readFileSync(join(cwdX, 'fl-x.txt'), 'utf-8') : null;
    const contentY = existsSync(join(cwdY, 'fl-y.txt')) ? readFileSync(join(cwdY, 'fl-y.txt'), 'utf-8') : null;
    assert.ok(contentX !== null, 'fl-x.txt should exist on disk');
    assert.ok(contentX?.includes('fl-x-ok'), `fl-x.txt should contain the requested text, got: ${contentX}`);
    assert.ok(contentY !== null, 'fl-y.txt should exist on disk');
    assert.ok(contentY?.includes('fl-y-ok'), `fl-y.txt should contain the requested text, got: ${contentY}`);
  });
});
