import { c } from './colors.js';
import type { ParsedResponse, TaskItem } from '../parser/markdown.js';

const BOX_WIDTH = 70;

let verboseMode = false;
export const setVerboseMode = (verbose: boolean): void => { verboseMode = verbose; };
export const isVerbose = (): boolean => verboseMode;

const pad = (s: string, w: number) => s + ' '.repeat(Math.max(0, w - s.length));
const wrap = (text: string, width: number): string[] => {
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    if (line.length + word.length + 1 > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.length ? lines : [''];
};

const box = (title: string, content: string, color = c.white): string => {
  const innerW = BOX_WIDTH - 4;
  const lines = content.split('\n').flatMap(l => l ? wrap(l, innerW) : ['']);
  const top = `┌─ ${title} ${'─'.repeat(Math.max(0, BOX_WIDTH - title.length - 5))}┐`;
  const bottom = `└${'─'.repeat(BOX_WIDTH - 2)}┘`;
  const body = lines.map(l => `│ ${color(pad(l, innerW))} │`).join('\n');
  return `${c.dim(top)}\n${body}\n${c.dim(bottom)}`;
};

const formatTask = (t: TaskItem): string => {
  const icon = t.status === 'complete' ? c.complete('[x]') : t.status === 'in-progress' ? c.inProgress('[~]') : c.pending('[ ]');
  const text = t.status === 'complete' ? c.complete(t.text) : t.status === 'in-progress' ? c.inProgress(t.text) : c.pending(t.text);
  return `${icon} ${text}`;
};

export const displayParsed = (parsed: ParsedResponse): void => {
  if (verboseMode) {
    console.log('\n' + box('Thoughts', parsed.thoughts, c.dim));
    if (parsed.taskList.length) {
      console.log('\n' + box('Task List', parsed.taskList.map(formatTask).join('\n'), c.white));
    }
    // Show all tools in verbose mode
    for (const tool of parsed.tools) {
      console.log('\n' + box(`Tool: ${tool.toolChoice}`, tool.toolInput || '(no input)', c.yellow));
    }
  } else {
    // Compact mode: show condensed thoughts
    if (parsed.thoughts) {
      const condensed = parsed.thoughts
        .split('\n')
        .map(l => l.trim())
        .filter(l => l)
        .slice(0, 3)
        .join(' ')
        .slice(0, 120);
      console.log(c.dim(`\n  💭 ${condensed}${parsed.thoughts.length > 120 ? '...' : ''}\n`));
    }
  }
  // In compact mode, tools are displayed via displayToolExecution as they execute
};

export const displayToolExecution = (toolChoice: string, inputPreview: string): void => {
  if (!verboseMode) {
    const toolDisplay = toolChoice === 'DONE' ? c.success('✓ Done') : c.yellow(`⚡ ${toolChoice}`);
    console.log(`  ${toolDisplay}${inputPreview ? c.dim(` ${inputPreview}`) : ''}`);
  }
};

export const displayResult = (result: string, isError = false): void => {
  if (verboseMode) {
    const title = isError ? 'Error' : 'Result';
    const color = isError ? c.red : c.white;
    console.log('\n' + box(title, result, color));
  } else {
    // Compact mode: show truncated result inline
    if (isError) {
      const preview = result.split('\n')[0].slice(0, 60);
      console.log(`    ${c.red('✗')} ${c.dim(preview)}${result.length > 60 ? '...' : ''}`);
    } else {
      const lines = result.split('\n');
      const preview = lines.slice(0, 3).map(l => `    ${c.dim(l.slice(0, 70))}`).join('\n');
      const more = lines.length > 3 ? c.dim(`\n    ... (${lines.length - 3} more lines)`) : '';
      console.log(preview + more);
    }
  }
};

export const displayFinalAnswer = (answer: string): void => {
  console.log('\n' + box('Answer', answer, c.cyan));
};

export const displayAuditStatus = (passed: boolean): void => {
  if (verboseMode) return; // Verbose mode shows full audit output
  const msg = passed ? c.success('✓ Verified') : c.yellow('⟳ Continuing...');
  console.log(`  ${msg}`);
};

export const displayWelcome = (): void => {
  console.log(c.bold.cyan('\n  dev.md') + c.dim(' - AI agent for development tasks\n'));
};

export const displaySessionInfo = (id: string, isResume = false): void => {
  console.log(c.dim(`  ${isResume ? 'Resumed' : 'Session'}: ${id}\n`));
};

export const displayCompression = (before: number, after: number): void => {
  console.log(c.magenta(`\n  Context compressed: ${before.toLocaleString()} → ${after.toLocaleString()} tokens\n`));
};
