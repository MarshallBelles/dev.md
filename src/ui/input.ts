import { c } from './colors.js';
import { isThinkingEnabled, toggleThinking } from './thinking.js';
import { SlashMenu, splitKeys } from './commands.js';

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
      const menu = new SlashMenu();

      // Visible width of the prompt, needed to put the cursor back on the input
      // line after drawing the palette underneath it.
      const promptWidth = (): number => {
        const raw = inMultiLine ? '  ... ' : (isThinkingEnabled() ? '💭   You: ' : '  You: ');
        return raw.length;
      };

      const writePrompt = () => {
        const prefix = inMultiLine ? c.dim('  ... ') : this.getPrompt();
        process.stdout.write(prefix);
      };

      // Draws the input line, then the match list beneath it, then parks the
      // cursor back at the end of the input so typing continues normally.
      const redrawLine = () => {
        process.stdout.write('\r\x1b[K');
        const prefix = inMultiLine ? c.dim('  ... ') : this.getPrompt();
        process.stdout.write(prefix + currentLine);
        // Clear anything previously drawn below (a stale palette).
        process.stdout.write('\x1b[J');

        if (!menu.isOpen()) return;

        const matches = menu.getMatches();
        const selectedIdx = menu.getSelectedIndex();
        process.stdout.write('\n');
        matches.forEach((m, i) => {
          const active = i === selectedIdx;
          const marker = active ? c.cyan('❯ ') : '  ';
          const name = active ? c.cyan(`/${m.command.name}`) : c.dim(`/${m.command.name}`);
          process.stdout.write(`  ${marker}${name}  ${c.dim(m.command.description)}\n`);
        });
        // Back up over the palette and re-park the cursor after the input text.
        process.stdout.write(`\x1b[${matches.length + 1}A`);
        process.stdout.write('\r');
        const col = promptWidth() + currentLine.length;
        if (col > 0) process.stdout.write(`\x1b[${col}C`);
      };

      const clearMenu = () => {
        if (!menu.isOpen()) return;
        menu.close();
        redrawLine();
      };

      writePrompt();

      // Enable raw mode
      if (process.stdin.isTTY) {
        process.stdin.setRawMode(true);
      }
      process.stdin.resume();

      // A single read can carry many characters - that is what pasting looks
      // like, and fast typing too. The old handler only accepted chunks of
      // length 1, so anything pasted was silently dropped. Split each chunk into
      // individual keys (keeping escape sequences intact) and feed them through
      // one at a time.
      let finished = false;

      const onData = (key: Buffer) => {
        for (const k of splitKeys(key.toString())) {
          if (finished) break;
          handleKey(k);
        }
      };

      const handleKey = (char: string) => {

        // Ctrl+C - exit
        if (char === '\x03') {
          process.stdout.write('\n');
          finished = true;
          if (process.stdin.isTTY) process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.exit(0);
        }

        // Arrow keys while the palette is open move the highlight.
        if (menu.isOpen() && (char === '\x1b[A' || char === '\x1b[B')) {
          if (char === '\x1b[A') menu.moveUp(); else menu.moveDown();
          redrawLine();
          return;
        }

        // Escape dismisses the palette without clearing what was typed.
        if (char === '\x1b') {
          if (menu.isOpen()) { clearMenu(); return; }
          return;
        }

        // Tab completes the highlighted command when the palette is open.
        if (char === '\t' && menu.isOpen()) {
          const completed = menu.accept();
          if (completed !== null) {
            currentLine = completed;
            menu.close();
            redrawLine();
          }
          return;
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
          // With the palette open, Enter runs the highlighted command rather
          // than submitting the partial text the user typed.
          if (menu.isOpen()) {
            const completed = menu.accept();
            if (completed !== null) {
              currentLine = completed;
              menu.close();
              redrawLine();
            }
          }
          process.stdout.write('\n');

          // Empty line handling
          menu.close();
          if (currentLine === '') {
            if (inMultiLine) {
              // Submit multi-line input
              finished = true;
              if (process.stdin.isTTY) process.stdin.setRawMode(false);
              process.stdin.removeListener('data', onData);
              resolve(lines.join('\n').trim());
              return;
            } else {
              // Submit empty
              finished = true;
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
            finished = true;
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
            menu.update(currentLine);
            redrawLine();
          }
          return;
        }

        // Ctrl+U - clear line
        if (char === '\x15') {
          currentLine = '';
          menu.update(currentLine);
          redrawLine();
          return;
        }

        // Regular character (printable)
        if (char.length === 1 && char.charCodeAt(0) >= 32) {
          currentLine += char;
          const wasOpen = menu.isOpen();
          menu.update(currentLine);
          // Only pay for a full redraw when the palette is involved; ordinary
          // typing stays a single-character write.
          if (menu.isOpen() || wasOpen) redrawLine();
          else process.stdout.write(char);
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
  • Type / to open the command palette (fuzzy match, ↑/↓ to pick, Tab/Enter to accept)
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