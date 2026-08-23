import ora, { Ora } from 'ora';
import { c } from './colors.js';

let spinner: Ora | null = null;
let tokenCount = 0;

export const startSpinner = (text = 'Thinking'): void => {
  tokenCount = 0;
  spinner = ora({ text: `${text}... ${c.dim(`[0 tokens]`)}`, spinner: 'dots' }).start();
};

export const updateTokens = (count: number): void => {
  tokenCount = count;
  if (spinner) spinner.text = `Thinking... ${c.dim(`[${tokenCount.toLocaleString()} tokens]`)}`;
};

export const incrementTokens = (delta = 1): void => updateTokens(tokenCount + delta);

// Lets callers tell whether a spinner was left running by an error path.
export const isSpinnerActive = (): boolean => spinner !== null;

// Update the label without touching the token counter - used to surface retries.
export const setSpinnerText = (text: string): void => {
  if (spinner) spinner.text = text;
};

export const stopSpinner = (success = true, text?: string): void => {
  if (!spinner) return;
  if (success) spinner.succeed(text || `Done ${c.dim(`[${tokenCount.toLocaleString()} tokens]`)}`);
  else spinner.fail(text || 'Failed');
  spinner = null;
};

export const getTokenCount = (): number => tokenCount;
