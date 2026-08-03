import { randomUUID } from 'crypto';
import { loadConfig } from '../config/index.js';
import { type Session, saveSession } from '../sessions/index.js';
import { type ToolContext } from '../tools/index.js';
import { runLoopTurn } from '../agent/loop-core.js';
import { buildSubagentPrompt } from '../agent/prompt.js';
import { displaySubagentStart, displaySubagentReply } from '../ui/display.js';

const createSubagentSession = (cwd: string): Session => ({
  id: randomUUID(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  workingDirectory: cwd,
  originalPrompt: '',
  taskList: [],
  history: [],
  totalTokens: 0,
  compressions: [],
});

// A subagent is a one-shot, fresh, isolated helper: no persistent identity, no
// peer-to-peer messaging - it gets a task, works alone with the full standard
// toolset, and reports back once via DONE. It may itself DELEGATE further,
// bounded by depth, but there is no concept of "the same subagent" across calls.
export const runSubagent = async (
  label: string,
  task: string,
  ctx: ToolContext,
  depth = 0,
): Promise<string> => {
  const config = loadConfig();

  if (depth > config.maxDelegateDepth) {
    return `ERROR: Delegation depth limit (${config.maxDelegateDepth}) exceeded - refusing to delegate further. Do this yourself or conclude with DONE.`;
  }

  const session = createSubagentSession(ctx.cwd);
  session.originalPrompt = task;
  session.history.push({ role: 'user', content: task });
  saveSession(session);

  displaySubagentStart(label, task);

  const systemPrompt = buildSubagentPrompt(ctx.automated, ctx.cwd);

  let result;
  try {
    result = await runLoopTurn({
      session,
      systemPrompt,
      ctx,
      maxLoops: config.subagentMaxLoops,
      maxRetries: config.maxRetriesAutomated,
      onDelegate: (nextLabel, nextTask) => runSubagent(nextLabel, nextTask, ctx, depth + 1),
      auditVerbose: false,
    });
  } catch (e) {
    const errorMsg = `ERROR: Subagent "${label}" failed: ${(e as Error).message}`;
    displaySubagentReply(label, errorMsg);
    return errorMsg;
  }

  if (result.type === 'maxLoopsReached') {
    const errorMsg = `ERROR: Subagent "${label}" did not reach a conclusion within its loop budget.`;
    displaySubagentReply(label, errorMsg);
    return errorMsg;
  }

  displaySubagentReply(label, result.summary);
  return result.summary;
};
