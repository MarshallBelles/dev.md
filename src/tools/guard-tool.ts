import { executeCommand } from './command.js';
import { guardCommand, type GuardConfig } from './guard.js';
import { permanentBlockMessage, declineMessage } from '../command-classifier/index.js';

/**
 * Run a shell command through the command guard and return the outcome as a
 * tool result string. This is the single, reusable command-execution path used
 * by the built-in COMMAND tool and by enterprise custom tools that opt into the
 * classifier (ToolAdapter.classify).
 *
 * A deterministic block (denylist or risk backstop) is treated as permanent -
 * the agent is told to stop and report the limitation. A classifier decline is
 * a judgment-based decision - the agent is nudged to try a different tool or a
 * safer approach and is not treated as a hard failure, so it keeps running.
 */
export const runGuardedCommand = async (
  cmd: string,
  cwd: string,
  config: GuardConfig
): Promise<string> => {
  const guard = await guardCommand(cmd, cwd, config);
  if (!guard.blocked) return await executeCommand(cmd, cwd);
  if (guard.source === 'classifier') return declineMessage(guard.reason);
  return permanentBlockMessage(guard.reason);
};
