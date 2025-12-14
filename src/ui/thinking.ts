import { streamCompletion } from '../agent/api.js';
import { c } from './colors.js';

// Global thinking mode state
let thinkingEnabled = false;

export const isThinkingEnabled = (): boolean => thinkingEnabled;
export const toggleThinking = (): boolean => {
  thinkingEnabled = !thinkingEnabled;
  return thinkingEnabled;
};
export const setThinking = (enabled: boolean): void => {
  thinkingEnabled = enabled;
};

const THINKING_PROMPT = `You are a reasoning assistant. Your job is to think carefully about the current situation and what to do next.

Given the tool result below, think step-by-step about:
1. What did we learn from this result?
2. Are there any errors or unexpected outcomes to address?
3. What should we do next and why?
4. Are we making progress toward the goal?

Be concise but thorough. Focus on insights that will help make the next decision.

DO NOT output any tool calls or action format. Just think out loud.`;

export interface ThinkingResult {
  thinking: string;
  tokens: number;
}

/**
 * Perform a thinking/reflection step after a tool result.
 * This calls the model without any tools, asking it to reason about the situation.
 */
export const performThinking = async (
  context: string,
  toolResult: string
): Promise<ThinkingResult> => {
  const messages = [
    { role: 'system' as const, content: THINKING_PROMPT },
    { role: 'user' as const, content: `## Context\n${context}\n\n## Latest Tool Result\n${toolResult}\n\nThink about this result and what to do next:` }
  ];

  try {
    const thinking = await streamCompletion(messages, { silent: true });
    return {
      thinking: thinking.trim(),
      tokens: Math.ceil(thinking.length / 4) // rough estimate
    };
  } catch (e) {
    return {
      thinking: `(Thinking failed: ${(e as Error).message})`,
      tokens: 0
    };
  }
};

/**
 * Display thinking output to the user
 */
export const displayThinking = (thinking: string): void => {
  const width = 70;
  const divider = '─'.repeat(width);

  console.log(c.dim(`\n  ┌─ 🧠 Thinking ${divider.slice(14)}┐`));

  // Word wrap the thinking content
  const lines = thinking.split('\n');
  for (const line of lines) {
    const words = line.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 > width - 6) {
        console.log(c.dim('  │ ') + c.dim(currentLine));
        currentLine = word;
      } else {
        currentLine = currentLine ? `${currentLine} ${word}` : word;
      }
    }
    if (currentLine) {
      console.log(c.dim('  │ ') + c.dim(currentLine));
    }
  }

  console.log(c.dim(`  └${divider}┘\n`));
};
