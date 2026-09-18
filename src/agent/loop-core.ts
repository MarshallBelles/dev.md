import { EventEmitter } from 'node:events';
import { loadConfig, resolveConfig } from '../config/index.js';
import { type Session, saveSession } from '../sessions/index.js';
import { parseResponse, extractDelegateInput } from '../parser/markdown.js';
import { executeTool, type ToolContext } from '../tools/index.js';
import { streamCompletion, isContextOverflowError } from './api.js';
import { needsCompression, compressContext, lastIterationStart } from './compress.js';
import { capToolOutput } from '../tools/output-store.js';
import { runAudit } from './audit.js';
import { displayParsed, displayResult, displayCompression, displayFinalAnswer, displayAuditStatus, displayToolExecution, isVerbose } from '../ui/display.js';
import { c } from '../ui/colors.js';
import { getTokenCount } from '../ui/spinner.js';
import { isThinkingEnabled, performThinking, displayThinking } from '../ui/thinking.js';
import type { AgentEventMap, InlineConfig, ToolCallHook } from '../lib/types.js';

export interface LoopTurnOptions {
  session: Session;
  systemPrompt: string;
  ctx: ToolContext;
  maxLoops: number;
  maxRetries: number;
  // Presence of this callback is what makes DELEGATE usable in this activation -
  // absence produces a clear ERROR tool result rather than a silently unavailable
  // tool. A subagent gets this too (bounded by depth), so it can itself delegate
  // a sub-task to a fresh helper.
  onDelegate?: (label: string, task: string) => Promise<string>;
  auditVerbose?: boolean;
  // --- Library / instance injection (all optional). When omitted the engine
  // behaves exactly as the CLI does today. ---
  // Inline config override; when omitted loadConfig() is used (file-backed CLI).
  config?: InlineConfig;
  // Typed event emitter. When present the engine runs in "library mode": it emits
  // model/tool/compression/etc events instead of relying solely on console output.
  events?: EventEmitter;
  // Output sink for high-level status when in library mode.
  sink?: (message: string) => void;
  // Invoked before every tool executes; may veto (skip) or rewrite the raw input.
  onToolCall?: ToolCallHook;
  // Cancels a running run.
  signal?: AbortSignal;
  // Overrides the global thinking state for this run.
  thinking?: boolean;
}

export type LoopTurnResult =
  | { type: 'done'; summary: string; auditPassed: boolean }
  | { type: 'maxLoopsReached'; maxLoops: number }
  | { type: 'aborted' };

export const runLoopTurn = async (options: LoopTurnOptions): Promise<LoopTurnResult> => {
  const { session, systemPrompt, ctx, maxLoops, maxRetries } = options;
  const config = options.config ? resolveConfig(options.config) : loadConfig();
  const auditVerbose = options.auditVerbose ?? isVerbose();
  const thinkingActive = options.thinking ?? isThinkingEnabled();

  // In "library mode" (events supplied) the host drives/observes via events; the
  // console display paths are left intact for the CLI, which never supplies
  // events, so CLI behaviour is byte-for-byte unchanged.
  const events = options.events;
  const libMode = Boolean(events);
  const emit = <K extends keyof AgentEventMap>(name: K, payload: AgentEventMap[K]) => {
    if (events) events.emit(name, payload);
  };

  const hasSystemPrompt = session.history.length > 0 && session.history[0].role === 'system';
  if (!hasSystemPrompt) {
    session.history.unshift({ role: 'system', content: systemPrompt });
  }

  let loops = 0;
  let retries = 0;
  // Detects the model repeating the exact same tool call over and over with no
  // progress - a real failure mode observed under long/complex context, where a
  // struggling model re-issues an identical action instead of moving forward.
  const recentToolSignatures: string[] = [];
  const MAX_IDENTICAL_REPEATS = 3;
  // Compaction driven by an actual server rejection rather than our own estimate.
  // Bounded because if compacting twice still doesn't fit, retrying won't help.
  let overflowCompactions = 0;
  const MAX_OVERFLOW_COMPACTIONS = 2;

  while (loops++ < maxLoops) {
    // Honour cancellation before starting fresh work.
    if (options.signal?.aborted) {
      emit('stop', { reason: 'aborted' });
      return { type: 'aborted' };
    }

    if (await needsCompression(session.history, session, config)) {
      const { messages, tokensBefore, tokensAfter } = await compressContext(session, systemPrompt, { config });
      session.history = messages;
      displayCompression(tokensBefore, tokensAfter);
      emit('compress', { tokensBefore, tokensAfter });
      saveSession(session);
      emit('save', { sessionId: session.id });
    }

    let response: string;
    try {
      const messagesSent = session.history.length;
      emit('model', { messagesLength: messagesSent });
      response = await streamCompletion(session.history, {
        // Library mode has no spinner - tokens are surfaced via 'token' events.
        silent: libMode,
        signal: options.signal,
        // Only recorded here: this is the one call that sends the loop's history.
        onUsage: usage => {
          session.lastPromptTokens = usage.prompt_tokens;
          session.lastPromptMessages = messagesSent;
          emit('usage', {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            total: usage.total_tokens,
          });
        },
        ...(libMode
          ? { onToken: (token: string) => emit('token', { token }) }
          : {}),
      });
      session.totalTokens += getTokenCount();
    } catch (e) {
      // The server rejected the prompt as too long. Our own estimate said it
      // would fit, so compact on the server's authority and retry rather than
      // re-sending the identical oversized prompt until retries run out.
      if (isContextOverflowError(e) && overflowCompactions < MAX_OVERFLOW_COMPACTIONS) {
        overflowCompactions++;
        // First attempt: walk back the iteration the server just rejected, compact
        // only the history behind it, then re-apply that iteration verbatim - it is
        // the freshest context and summarising it away loses the most useful part.
        // Second attempt: the tail itself is too big, so compact everything.
        const preserveFrom = overflowCompactions === 1 ? lastIterationStart(session) : undefined;
        console.log(c.yellow(
          preserveFrom !== undefined
            ? `\n  Context overflow reported by server - rewinding one iteration, compacting, and replaying it...\n`
            : `\n  Context overflow reported by server - compacting and retrying...\n`
        ));
        const { messages, tokensBefore, tokensAfter } = await compressContext(session, systemPrompt, { preserveFrom, config });
        session.history = messages;
        displayCompression(tokensBefore, tokensAfter);
        emit('compress', { tokensBefore, tokensAfter });
        saveSession(session);
        emit('save', { sessionId: session.id });
        continue;
      }
      console.log(c.red(`\n  API Error: ${(e as Error).message}\n`));
      if (++retries >= maxRetries) { emit('error', { error: e as Error }); throw e; }
      console.log(c.dim(`  Retrying (${retries}/${maxRetries})...\n`));
      continue;
    }

    const parsed = parseResponse(response);
    if (!parsed) {
      console.log(c.yellow('\n  Response format error, retrying...\n'));
      session.history.push({ role: 'assistant', content: response });
      session.history.push({ role: 'user', content: 'ERROR: Your response was not in the correct format. Please use the exact format specified with # Agent Response, ## Thoughts, ## Task List, ## Tool Choice, and ## Tool Input sections.' });
      saveSession(session);
      if (++retries >= maxRetries) { emit('error', { error: new Error('Max retries exceeded on parse failures') }); throw new Error('Max retries exceeded on parse failures'); }
      continue;
    }

    retries = 0;
    session.history.push({ role: 'assistant', content: parsed.raw });
    session.taskList = parsed.taskList.map(t => ({ status: t.status, text: t.text }));
    emit('parse', { thoughts: parsed.thoughts, toolCount: parsed.tools.length });
    displayParsed(parsed);
    saveSession(session);
    emit('save', { sessionId: session.id });

    const hasDone = parsed.tools.some(t => t.toolChoice === 'DONE');
    const signature = parsed.tools.map(t => `${t.toolChoice}:${t.toolInput}`).join('|');
    recentToolSignatures.push(signature);
    if (recentToolSignatures.length > MAX_IDENTICAL_REPEATS) recentToolSignatures.shift();
    const isStuckRepeating = !hasDone &&
      recentToolSignatures.length === MAX_IDENTICAL_REPEATS &&
      recentToolSignatures.every(s => s === signature);

    if (isStuckRepeating) {
      console.log(c.yellow(`\n  Detected the same action repeated ${MAX_IDENTICAL_REPEATS}x with no progress, interrupting...\n`));
      session.history.push({
        role: 'user',
        content: `WARNING: You have called the exact same tool with the exact same input ${MAX_IDENTICAL_REPEATS} times in a row with no progress. Do not repeat this action again. Either take a genuinely different next step, or if you cannot proceed, use DONE to report the blocker to the user.`,
      });
      recentToolSignatures.length = 0;
      saveSession(session);
      continue;
    }

    // Execute all tools in sequence
    const toolResults: string[] = [];
    let hitDone = false;
    let doneSummary = '';

    for (const tool of parsed.tools) {
      // Show tool execution in compact mode (verbose mode already showed all tools in displayParsed)
      if (!isVerbose()) {
        displayToolExecution(tool.toolChoice, tool.toolInput.split('\n')[0].slice(0, 40));
      }

      if (tool.toolChoice === 'DONE') {
        hitDone = true;
        doneSummary = tool.toolInput;
        break; // Don't execute anything after DONE
      }

      // Library hook: veto (skip) or rewrite the raw input before any tool runs.
      if (options.onToolCall) {
        const hookResult = await options.onToolCall({ tool: tool.toolChoice, input: tool.toolInput, turn: loops });
        if (hookResult && hookResult.veto) {
          const vetoed = '[vetoed by policy]';
          toolResults.push(`[${tool.toolChoice}]: ${vetoed}`);
          emit('tool', { tool: tool.toolChoice, input: tool.toolInput, turn: loops, result: vetoed });
          continue; // skip execution but keep the loop going
        }
        if (hookResult && hookResult.rewrite !== undefined) {
          tool.toolInput = hookResult.rewrite;
        }
      }

      let result: string;

      if (tool.toolChoice === 'DELEGATE') {
        if (!options.onDelegate) {
          result = 'ERROR: DELEGATE is not available in this context.';
        } else {
          const parsedInput = extractDelegateInput(tool.toolInput);
          if (!parsedInput) {
            result = 'ERROR: DELEGATE requires a quoted label and a fenced task body.'
          } else {
            result = await options.onDelegate(parsedInput.label, parsedInput.task);
          }
        }
      } else {
        try {
          result = await executeTool(tool.toolChoice, tool.toolInput, ctx);
        } catch (e) {
          result = `ERROR: ${(e as Error).message}`;
        }
      }

      // Cap before this enters history - an uncapped result can exceed the
      // entire compaction reserve in a single step.
      result = capToolOutput(tool.toolChoice, result);

      toolResults.push(`[${tool.toolChoice}]: ${result}`);
      emit('tool', { tool: tool.toolChoice, input: tool.toolInput, turn: loops, result });
      displayResult(result, result.startsWith('ERROR'));

      // Stop on error to let model recover
      if (result.startsWith('ERROR')) {
        break;
      }
    }

    // Add combined tool results to history
    if (toolResults.length > 0) {
      const toolResultsContent = `Tool results:\n${toolResults.join('\n\n')}`;
      session.history.push({ role: 'user', content: toolResultsContent });
      saveSession(session);
      emit('save', { sessionId: session.id });

      // Perform thinking step if enabled (and not hitting DONE)
      if (thinkingActive && !hitDone) {
        const context = `Original task: ${session.originalPrompt}\n\nCurrent progress: ${session.taskList.map(t => `[${t.status === 'complete' ? 'x' : t.status === 'in-progress' ? '~' : ' '}] ${t.text}`).join('\n')}`;
        const thinkingResult = await performThinking(context, toolResultsContent);

        if (thinkingResult.thinking) {
          displayThinking(thinkingResult.thinking);
          // Add thinking as context for the next response (as user message to avoid consecutive assistant messages)
          session.history.push({
            role: 'user',
            content: `[Your reasoning from thinking step]:\n${thinkingResult.thinking}\n\nNow continue with your next action based on this analysis.`
          });
          session.totalTokens += thinkingResult.tokens;
          saveSession(session);
        }
      }
    }

    // Handle DONE after executing preceding tools
    if (hitDone) {
      const audit = await runAudit(session, doneSummary, auditVerbose);

      if (audit.passed) {
        emit('done', { summary: doneSummary, auditPassed: true });
        if (auditVerbose) {
          console.log(c.success('\n  Audit PASSED - Task complete!\n'));
          displayResult(audit.feedback);
        } else {
          displayFinalAnswer(doneSummary);
          displayAuditStatus(true);
        }
        return { type: 'done', summary: doneSummary, auditPassed: true };
      }

      if (auditVerbose) {
        console.log(c.yellow('\n  Audit FAILED - Continuing...\n'));
        displayResult(audit.feedback, true);
      } else {
        displayAuditStatus(false);
      }
      session.history.push({
        role: 'user',
        content: `AUDIT FAILED. Please address the following issues:\n\n${audit.feedback}`,
      });
      saveSession(session);
      continue;
    }
  }

  emit('maxLoopsReached', { maxLoops });
  console.log(c.red(`\n  Max loops (${maxLoops}) reached. Stopping.\n`));
  return { type: 'maxLoopsReached', maxLoops };
};
