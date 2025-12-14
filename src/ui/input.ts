import { c } from './colors.js';
import { isThinkingEnabled, toggleThinking } from './thinking.js';

export interface EnhancedInputOptions {
  cwd: string;
  prompt?: string;
}

export class EnhancedInput {
  private prompt: string;

  constructor(options: EnhancedInputOptions) {
    this.prompt = options.prompt || c.cyan('  You: ');
  }

  private getPrompt(): string {
    const thinkingIndicator = isThinkingEnabled() ? c.magenta('💭 ') : '';
    return thinkingIndicator + this.prompt;
  }

  async getInput(): Promise<string> {
    return new Promise((resolve) => {
      const lines: string[] = [];
      let currentLine = '';
      let inMultiLine = false;

      const writePrompt = () => {
        const prefix = inMultiLine ? c.dim('  ... ') : this.getPrompt();
        process.stdout.write(prefix);
      };

      const redrawLine = () => {
        // Clear current line and rewrite
        process.stdout.write('\r\x1b[K');
        const prefix = inMultiLine ? c.dim('  ... ') : this.getPrompt();
        process.stdout.write(prefix + currentLine);
      };

      writePrompt();

      // Enable raw mode
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      const onData = (key: Buffer) => {
        const char = key.toString();

        // Ctrl+C - exit
        if (char === '\x03') {
          process.stdout.write('\n');
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.exit(0);
        }

        // Tab - toggle thinking mode
        if (char === '\t') {
          toggleThinking();
          const state = isThinkingEnabled() ? c.green('ON') : c.red('OFF');
          process.stdout.write(`\n  ${c.yellow('Thinking mode:')} ${state}\n`);
          redrawLine();
          return;
        }

        // Enter - submit line
        if (char === '\r' || char === '\n') {
          process.stdout.write('\n');

          // Empty line handling
          if (currentLine === '') {
            if (inMultiLine) {
              // Submit multi-line input
              if (process.stdin.isTTY) process.stdin.setRawMode(false);
              process.stdin.removeListener('data', onData);
              resolve(lines.join('\n').trim());
              return;
            } else {
              // Submit empty
              if (process.stdin.isTTY) process.stdin.setRawMode(false);
              process.stdin.removeListener('data', onData);
              resolve('');
              return;
            }
          }

          // Check for multi-line indicators
          const isMultiLineStart = currentLine.endsWith('\\') ||
                                   currentLine.endsWith('{') ||
                                   currentLine.endsWith('[') ||
                                   currentLine.includes('```');

          if (isMultiLineStart && !inMultiLine) {
            inMultiLine = true;
          }

          // Remove trailing backslash if used as continuation
          if (currentLine.endsWith('\\')) {
            lines.push(currentLine.slice(0, -1));
          } else {
            lines.push(currentLine);
          }

          currentLine = '';

          // If not in multi-line mode, submit immediately
          if (!inMultiLine) {
            if (process.stdin.isTTY) process.stdin.setRawMode(false);
            process.stdin.removeListener('data', onData);
            resolve(lines.join('\n').trim());
            return;
          }

          writePrompt();
          return;
        }

        // Backspace
        if (char === '\x7f' || char === '\b') {
          if (currentLine.length > 0) {
            currentLine = currentLine.slice(0, -1);
            process.stdout.write('\b \b');
          }
          return;
        }

        // Ctrl+U - clear line
        if (char === '\x15') {
          currentLine = '';
          redrawLine();
          return;
        }

        // Regular character (printable)
        if (char.length === 1 && char.charCodeAt(0) >= 32) {
          currentLine += char;
          process.stdout.write(char);
        }
      };

      process.stdin.on('data', onData);
    });
  }

  showHelp(): void {
    console.log(c.dim(`
  Input tips:
  • End line with \\ for multi-line input
  • Empty line submits in multi-line mode
  • "exit" to quit, "new" for new session
  • Tab to toggle thinking mode (💭 appears in prompt when active)
  • Ctrl+U to clear line, Ctrl+C to exit
`));
  }

  close(): void {
    // No persistent state to clean up anymore
  }

  // Export the thinking state for the agent to use
  static getThinkingState(): boolean {
    return isThinkingEnabled();
  }
}