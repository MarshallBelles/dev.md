import * as readline from 'readline';
import { readdirSync } from 'fs';
import { join, relative, basename } from 'path';
import { c } from './colors.js';

interface FileMatch {
  path: string;
  name: string;
  score: number;
}

// Simple fuzzy matching - returns score (higher is better, 0 = no match)
const fuzzyMatch = (pattern: string, text: string): number => {
  const p = pattern.toLowerCase();
  const t = text.toLowerCase();

  if (t === p) return 1000;
  if (t.includes(p)) return 500 + (p.length / t.length) * 100;

  let pi = 0;
  let score = 0;
  let consecutive = 0;

  for (let ti = 0; ti < t.length && pi < p.length; ti++) {
    if (t[ti] === p[pi]) {
      score += 10 + consecutive * 5;
      consecutive++;
      pi++;
    } else {
      consecutive = 0;
    }
  }

  return pi === p.length ? score : 0;
};

// Recursively find files (limited depth)
const findFiles = (dir: string, maxDepth = 4, currentDepth = 0): string[] => {
  if (currentDepth > maxDepth) return [];

  const results: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith('.') ||
          entry.name === 'node_modules' ||
          entry.name === 'dist' ||
          entry.name === 'build' ||
          entry.name === '__pycache__') continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        results.push(...findFiles(fullPath, maxDepth, currentDepth + 1));
      } else {
        results.push(fullPath);
      }
    }
  } catch {
    // Ignore permission errors
  }
  return results;
};

// Search for files matching a pattern
export const searchFiles = (pattern: string, cwd: string, limit = 5): FileMatch[] => {
  if (!pattern) return [];

  const files = findFiles(cwd);
  const matches: FileMatch[] = [];

  for (const file of files) {
    const name = basename(file);
    const relPath = relative(cwd, file);
    const nameScore = fuzzyMatch(pattern, name);
    const pathScore = fuzzyMatch(pattern, relPath) * 0.5;
    const score = Math.max(nameScore, pathScore);

    if (score > 0) {
      matches.push({ path: relPath, name, score });
    }
  }

  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
};

export interface EnhancedInputOptions {
  cwd: string;
  prompt?: string;
}

export class EnhancedInput {
  private cwd: string;
  private prompt: string;
  private fileCache: string[] | null = null;

  constructor(options: EnhancedInputOptions) {
    this.cwd = options.cwd;
    this.prompt = options.prompt || c.cyan('  You: ');
  }

  private getFiles(): string[] {
    if (!this.fileCache) {
      this.fileCache = findFiles(this.cwd);
    }
    return this.fileCache;
  }

  private createCompleter(): readline.Completer {
    return (line: string): [string[], string] => {
      // Check for @pattern at end of line
      const atMatch = line.match(/@(\S*)$/);
      if (atMatch) {
        const pattern = atMatch[1];
        const files = this.getFiles();
        const matches: string[] = [];

        for (const file of files) {
          const name = basename(file);
          const relPath = relative(this.cwd, file);
          if (!pattern || fuzzyMatch(pattern, name) > 0 || fuzzyMatch(pattern, relPath) > 0) {
            matches.push(relPath);
          }
        }

        // Sort by score and limit
        const scored = matches.map(m => ({
          path: m,
          score: Math.max(fuzzyMatch(pattern, basename(m)), fuzzyMatch(pattern, m) * 0.5)
        }));
        scored.sort((a, b) => b.score - a.score);
        const topMatches = scored.slice(0, 8).map(s => s.path);

        // Return completions that replace @pattern
        const prefix = line.slice(0, line.length - atMatch[0].length);
        const completions = topMatches.map(m => prefix + m);

        return [completions, line];
      }

      return [[], line];
    };
  }

  async getInput(): Promise<string> {
    return new Promise((resolve) => {
      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
        completer: this.createCompleter()
      });

      const lines: string[] = [];
      let inMultiLine = false;

      const promptForLine = () => {
        const prefix = inMultiLine ? c.dim('  ... ') : this.prompt;

        rl.question(prefix, (line) => {
          // Empty line in multi-line mode = submit
          if (inMultiLine && line === '') {
            rl.close();
            resolve(lines.join('\n').trim());
            return;
          }

          // First empty line = submit empty (let caller handle)
          if (!inMultiLine && line === '') {
            rl.close();
            resolve('');
            return;
          }

          // Check for multi-line indicators
          const isMultiLineStart = line.endsWith('\\') ||
                                   line.endsWith('{') ||
                                   line.endsWith('[') ||
                                   line.includes('```');

          if (isMultiLineStart && !inMultiLine) {
            inMultiLine = true;
          }

          // Remove trailing backslash if used as continuation
          if (line.endsWith('\\')) {
            lines.push(line.slice(0, -1));
          } else {
            lines.push(line);
          }

          // If not in multi-line mode, submit immediately
          if (!inMultiLine) {
            rl.close();
            resolve(lines.join('\n').trim());
            return;
          }

          promptForLine();
        });
      };

      promptForLine();
    });
  }

  showHelp(): void {
    console.log(c.dim(`
  Input tips:
  • Type @filename then Tab to autocomplete file paths
  • End line with \\ for multi-line input
  • Empty line submits in multi-line mode
  • "exit" to quit, "new" for new session
`));
  }

  close(): void {
    // No persistent state to clean up anymore
  }

  clearCache(): void {
    this.fileCache = null;
  }
}
