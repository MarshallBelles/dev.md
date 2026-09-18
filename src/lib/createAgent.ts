import { EventEmitter } from 'node:events';
import { createSession, loadSession } from '../sessions/index.js';
import { runAgentLoop } from '../agent/loop.js';
import { resolveConfig } from '../config/index.js';
import type { Agent, AgentOptions, RunResult, RunInput } from './types.js';

/**
 * Build a reusable, event-driven, hookable agent instance. This is the library
 * entry point - the CLI is a thin adapter on top of it (see src/index.ts).
 *
 * The returned handle drives the existing agent engine in-process. It:
 *  - runs headlessly against whatever endpoint is supplied via `config`
 *    (no config file or process environment is required),
 *  - emits a typed event stream ('start' | 'model' | 'token' | 'usage' |
 *    'parse' | 'tool' | 'compress' | 'save' | 'done' | 'maxLoopsReached' |
 *    'stop' | 'error'),
 *  - lets a host veto or rewrite tool calls before they execute,
 *  - supports cancellation via AbortSignal.
 */
export const createAgent = (options: AgentOptions = {}): Agent => {
  const events: EventEmitter = options.events ?? new EventEmitter();
  const sink = options.sink ?? { log: (message: string) => console.log(message) };
  // A plain function the engine can call for status output; falls back to
  // console.log so the CLI and bare library use keep working.
  const sinkLog = (message: string) => (options.sink?.log ?? console.log)(message);
  const cwd = options.cwd ?? process.cwd();
  const config = resolveConfig(options.config);

  let current: ReturnType<typeof createSession> | null = null;
  let stopped = false;
  let started = false;
  let controller: AbortController | null = null;

  const runLoop = async (input?: RunInput): Promise<RunResult> => {
    if (stopped) {
      const error = new Error('Agent has been stopped');
      events.emit('error', { error });
      return { type: 'error', error };
    }

    let session = current;
    if (input?.sessionId) {
      session = loadSession(input.sessionId);
      if (!session) {
        const error = new Error(`Session not found: ${input.sessionId}`);
        events.emit('error', { error });
        return { type: 'error', error };
      }
    } else if (options.resume) {
      session = loadSession(options.resume);
      if (!session) {
        const error = new Error(`Session not found: ${options.resume}`);
        events.emit('error', { error });
        return { type: 'error', error };
      }
    } else {
      session = createSession(cwd, input?.prompt ?? '');
      if (input?.prompt) {
        session.originalPrompt = input.prompt;
        session.history.push({ role: 'user', content: input.prompt });
      }
    }
    current = session;
    stopped = false;
    controller = new AbortController();

    // Warmup: a bare first run() with no prompt/sessionId just establishes the
    // session (e.g. for an interactive REPL that waits for user input before
    // running). Subsequent run() calls drive the loop.
    if (!started && !input?.prompt && !input?.sessionId) {
      started = true;
      events.emit('start', { sessionId: session.id, cwd });
      return { type: 'idle' };
    }
    started = true;

    const signal = options.signal
      ? AbortSignal.any([options.signal, controller.signal])
      : controller.signal;

    const hooks = {
      config,
      events,
      sink: sinkLog,
      onToolCall: options.onToolCall,
      onDelegate: options.onDelegate,
      signal,
      thinking: options.thinking,
      verbose: options.verbose,
    };

    events.emit('start', { sessionId: session.id, cwd });

    try {
      const result = await runAgentLoop(session, {
        automated: options.automated ?? !!input?.prompt,
      }, hooks);
      switch (result.type) {
        case 'done':
          return { type: 'done', summary: result.summary, auditPassed: result.auditPassed };
        case 'maxLoopsReached':
          return { type: 'maxLoopsReached', maxLoops: result.maxLoops };
        case 'aborted':
          return { type: 'aborted' };
        default:
          return { type: 'error', error: new Error('Unknown run result') };
      }
    } catch (e) {
      const error = e as Error;
      events.emit('error', { error });
      return { type: 'error', error };
    } finally {
      controller = null;
    }
  };

  const agent: Agent = {
    get sessionId() { return current?.id ?? ''; },
    get cwd() { return cwd; },
    get events() { return events; },
    get sink() { return sink; },
    getConfig() { return { ...config }; },
    run: (input?: RunInput) => runLoop(input),
    resume: (sessionId: string) => runLoop({ sessionId, automated: options.automated }),
    inject: (role: 'user' | 'system' | 'assistant', content: string) => {
      if (!current) throw new Error('No active session to inject into; call run() or resume() first');
      current.history.push({ role, content });
    },
    stop: () => {
      stopped = true;
      controller?.abort();
      events.emit('stop', {});
    },
    isStopped: () => stopped,
  };

  return agent;
};
