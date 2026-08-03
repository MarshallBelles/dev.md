import { loadConfig } from '../config/index.js';
import { type Session, saveSession } from '../sessions/index.js';
import { type ToolContext } from '../tools/index.js';
import { buildSystemPrompt } from './prompt.js';
import { runLoopTurn } from './loop-core.js';
import { runSubagent } from '../subagent/index.js';
import { isVerbose } from '../ui/display.js';

export interface LoopOptions {
  automated: boolean;
}

export const runAgentLoop = async (session: Session, options: LoopOptions): Promise<void> => {
  const config = loadConfig();
  const maxRetries = options.automated ? config.maxRetriesAutomated : config.maxRetries;
  const systemPrompt = buildSystemPrompt(options.automated, session.workingDirectory);
  const ctx: ToolContext = { cwd: session.workingDirectory, automated: options.automated };

  await runLoopTurn({
    session,
    systemPrompt,
    ctx,
    maxLoops: config.maxLoops,
    maxRetries,
    auditVerbose: isVerbose(),
    onDelegate: (label, task) => runSubagent(label, task, ctx, 0),
  });
};

export const runSinglePrompt = async (session: Session, prompt: string): Promise<void> => {
  session.originalPrompt = prompt;
  session.history.push({ role: 'user', content: prompt });
  saveSession(session);
};
