// Live slash-command palette. Kept free of any stdout writing so the matching
// and selection behaviour is unit-testable; ui/input.ts owns the rendering.

export interface SlashCommand {
  name: string;
  description: string;
  // Extra words the command should be findable by, for when the user types what
  // the thing does rather than what it is called ("quit" -> /exit).
  keywords?: string[];
}

export const COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'Show input tips and available commands', keywords: ['tips', 'usage', 'commands'] },
  { name: 'new', description: 'Start a fresh session in this directory', keywords: ['reset', 'restart', 'clear'] },
  { name: 'exit', description: 'Quit dev.md', keywords: ['quit', 'bye', 'close'] },
  { name: 'think', description: 'Toggle thinking/reflection mode', keywords: ['reflect', 'reasoning', 'deep'] },
  { name: 'config', description: 'Open the config file in your editor', keywords: ['settings', 'setup', 'endpoint', 'model'] },
  { name: 'sessions', description: 'List recent sessions', keywords: ['history', 'past', 'resume'] },
  { name: 'status', description: 'Show the current session id and token usage', keywords: ['info', 'tokens', 'usage'] },
];

export interface Match {
  command: SlashCommand;
  score: number;
}

// fzf-style subsequence scoring: every query character must appear in order.
// Consecutive runs and matches at the start of the name score highest, so
// typing "se" ranks /sessions above /reset-style incidental matches.
const subsequenceScore = (query: string, target: string): number | null => {
  if (!query) return 1;
  let score = 0;
  let ti = 0;
  let lastHit = -1;
  let consecutive = 0;

  for (const qc of query) {
    let hit = -1;
    for (let i = ti; i < target.length; i++) {
      if (target[i] === qc) { hit = i; break; }
    }
    if (hit === -1) return null;

    if (hit === 0) score += 10;                 // matches the very first char
    if (hit === lastHit + 1) { consecutive++; score += 5 + consecutive; }
    else consecutive = 0;
    // Earlier matches are better than ones buried deep in the word.
    score += Math.max(0, 5 - hit);

    lastHit = hit;
    ti = hit + 1;
  }

  // Prefer tighter matches: "co" should favour /config over a longer name.
  score += Math.max(0, 12 - target.length);
  if (target.startsWith(query)) score += 25;
  if (target === query) score += 50;
  return score;
};

// Damerau-Levenshtein (optimal string alignment), used only to rescue typos that
// break the subsequence rule outright. Counts an adjacent transposition as a
// single edit, which plain Levenshtein scores as two - and transposition is by
// far the most common typing slip ("exti" for "exit").
const editDistance = (a: string, b: string): number => {
  const d: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) d[i][0] = i;
  for (let j = 0; j <= b.length; j++) d[0][j] = j;

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,        // deletion
        d[i][j - 1] + 1,        // insertion
        d[i - 1][j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1); // transposition
      }
    }
  }
  return d[a.length][b.length];
};

export const scoreCommand = (query: string, command: SlashCommand): number | null => {
  const q = query.toLowerCase();
  const direct = subsequenceScore(q, command.name.toLowerCase());
  if (direct !== null) return direct;

  // Keywords let "quit" find /exit. Scored lower than a name match so the
  // command's own name always wins when both hit.
  for (const kw of command.keywords ?? []) {
    const s = subsequenceScore(q, kw.toLowerCase());
    if (s !== null) return Math.max(0, s - 15);
  }

  // Typo rescue: only for queries long enough that a near-miss is meaningful.
  if (q.length >= 3) {
    const dist = editDistance(q, command.name.toLowerCase());
    if (dist <= Math.max(1, Math.floor(q.length / 3))) return 5 - dist;
  }
  return null;
};

export const matchCommands = (query: string, limit = 6): Match[] =>
  COMMANDS
    .map(command => ({ command, score: scoreCommand(query, command) }))
    .filter((m): m is Match => m.score !== null)
    .sort((a, b) => b.score - a.score || a.command.name.localeCompare(b.command.name))
    .slice(0, limit);

// True when the line is a slash-command context: starts with "/" and has no
// whitespace yet, so "/config" opens the menu but "/path/to/file thing" doesn't.
export const isSlashContext = (line: string): boolean =>
  line.startsWith('/') && !line.slice(1).includes(' ');

// Selection state for the live palette, driven purely by the current input line.
export class SlashMenu {
  private matches: Match[] = [];
  private selected = 0;
  private open = false;

  // Recomputes from the current line. Selection resets whenever the query
  // changes so the highlight never points at a stale entry.
  update(line: string): void {
    if (!isSlashContext(line)) { this.close(); return; }
    this.matches = matchCommands(line.slice(1));
    this.open = this.matches.length > 0;
    this.selected = 0;
  }

  close(): void { this.open = false; this.matches = []; this.selected = 0; }
  isOpen(): boolean { return this.open; }
  getMatches(): Match[] { return this.matches; }
  getSelectedIndex(): number { return this.selected; }
  getSelected(): SlashCommand | undefined { return this.matches[this.selected]?.command; }

  moveDown(): void {
    if (this.open && this.matches.length) this.selected = (this.selected + 1) % this.matches.length;
  }
  moveUp(): void {
    if (this.open && this.matches.length) {
      this.selected = (this.selected - 1 + this.matches.length) % this.matches.length;
    }
  }

  // The line the input should become when the user accepts the highlighted entry.
  accept(): string | null {
    const cmd = this.getSelected();
    return cmd ? `/${cmd.name}` : null;
  }
}

// Normalises a submitted line to a command name, accepting both "/exit" and the
// bare legacy forms ("exit", "help", "?") that interactive mode already took.
export const resolveCommand = (line: string): SlashCommand | undefined => {
  const t = line.trim().toLowerCase();
  if (!t) return undefined;
  const bare = t.startsWith('/') ? t.slice(1) : t;
  if (bare === '?') return COMMANDS.find(c => c.name === 'help');
  const exact = COMMANDS.find(c => c.name === bare);
  if (exact) return exact;
  // Legacy aliases that were accepted before slash commands existed.
  if (bare === 'quit') return COMMANDS.find(c => c.name === 'exit');
  // A bare word that isn't a command is a prompt, not a typo to guess at.
  return t.startsWith('/') ? matchCommands(bare, 1)[0]?.command : undefined;
};

// Splits one stdin chunk into individual key events. A single read can carry
// many characters - pasting is the obvious case, fast typing another - and
// arrow keys arrive as a 3-byte escape sequence that must stay intact.
export const splitKeys = (data: string): string[] => {
  const keys: string[] = [];
  let i = 0;
  while (i < data.length) {
    if (data[i] === '\x1b') {
      const seq = data.slice(i, i + 3);
      if (/^\x1b\[[A-D]$/.test(seq)) { keys.push(seq); i += 3; continue; }
      keys.push('\x1b'); i += 1; continue;
    }
    keys.push(data[i]); i += 1;
  }
  return keys;
};
