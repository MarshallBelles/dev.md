// Cheap heuristic risk score (0-100) for a shell command, no LLM.
//
// This is NOT the safety net - it exists to (a) let the classifier skip
// obviously benign commands and (b) catch obfuscated / "hidden in plain sight"
// variants of catastrophic commands that the deterministic denylist regexes
// miss, so they trip the deterministic risk backstop instead of being approved
// on a low score. The real semantic judgement always happens in the classifier.
//
// Weights are additive and capped at 100. Genuinely benign commands score 0
// (ls, cat, echo, git status, npm test ...); any command carrying a risk signal
// scores high enough to be classified or backstopped.

type Signal = { test: RegExp; weight: number; reason: string };

const SIGNALS: Signal[] = [
  // Catastrophic / no-regret (also covered by the denylist; here they catch
  // obfuscated variants that slip the denylist regexes).
  { test: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, weight: 100, reason: 'Fork bomb pattern.' },
  { test: /(\b|\s)(mkfs|wipefs|mkswap)\b/i, weight: 95, reason: 'Filesystem destructive operation.' },
  { test: /\bdd\b[^\n]*\bof=\/dev\//i, weight: 95, reason: 'Raw write to a block device.' },
  { test: />\s*\/dev\/(disk|sd|nvme|hd|rdisk|nvd)/i, weight: 90, reason: 'Write redirected to a block device.' },
  { test: /(\b|\s)(base64|base32|xxd|openssl)\b[^\n]*\|\s*(sh|bash|zsh|python|ruby|perl)\b/i, weight: 90, reason: 'Obfuscated/downloaded code piped into an interpreter.' },
  { test: /(\b|\s)(curl|wget)\b[^\n]*\|\s*(sh|bash|zsh|python)\b/i, weight: 90, reason: 'Piping a remote download directly into a shell.' },
  { test: /\b(rm|rmdir|truncate)\b[^\n]*(-rf|-fr|--recursive)?[^\n]*\/[^\n]*\b/i, weight: 90, reason: 'Destructive operation on an absolute path outside the working directory.' },
  // Gray area: privilege / system / destructive-but-scoped.
  { test: /(\b|\s)(sudo|setpriv|setuid)\b/i, weight: 55, reason: 'Privilege escalation.' },
  { test: /(\b|\s)(shutdown|reboot|halt|poweroff)\b/i, weight: 50, reason: 'System power command.' },
  { test: /(\b|\s)(systemctl|service|launchctl)\b[i]?/i, weight: 45, reason: 'System service control.' },
  { test: /(\b|\s)(chmod|chown)\b/i, weight: 45, reason: 'Permission change.' },
  { test: /(\b|\s)(nc|ncat|socat)\b/i, weight: 50, reason: 'Raw network socket usage.' },
  { test: /\b(scp|rsync)\b[^\n]*:[\/~]/i, weight: 45, reason: 'Remote file transfer.' },
  { test: /(^|\s)(openssl)\b[^\n]*(enc|rsa|gen|pkcs|req)/i, weight: 45, reason: 'Crypto / key-material operation.' },
  { test: /(id_rsa|\.ssh\/|\.pem|\.env\b|private[ _]key|\.key\b)/i, weight: 40, reason: 'Accessing credentials or secrets.' },
  // Obfuscation that is ambiguous (could be benign) -> classify, do not backstop.
  { test: /(\b|\s)(perl|python[0-9]?|ruby|node|sh|bash)\b[^\n]*(-e|-c)\b/i, weight: 50, reason: 'Interpreter one-liner (possible obfuscation).' },
  { test: /(^|\s)(eval|xargs|exec)\b/i, weight: 50, reason: 'Eval / xargs / exec (possible obfuscation).' },
  // History rewrite / force push -> judged, not hard-blocked.
  { test: /\bgit\s+(push\s+--force|push\s+-f|push\s+--force-with-lease|push\s+-f\s+\+|push\s+\+\S+|reset\s+--hard|reset\s+-hard|reflog|filter-branch|branch\s+-D|push\s+--delete)/i, weight: 70, reason: 'Git history rewrite or force push.' },
  { test: /\bgit\s+push\b[i]?/i, weight: 25, reason: 'Push to a remote.' },
  // Scoped destructive ops -> classify.
  { test: /\b(rm|rmdir|truncate|shred)\b/i, weight: 30, reason: 'Destructive file operation.' },
];

export interface ScoreResult {
  risk: number;
  signals: string[];
}

/** Score a command 0-100 and report which signals fired. Benign commands score 0. */
export const scoreCommand = (command: string): ScoreResult => {
  const signals: string[] = [];
  let risk = 0;
  for (const { test, weight, reason } of SIGNALS) {
    if (test.test(command)) {
      risk += weight;
      signals.push(reason);
    }
  }
  return { risk: Math.min(100, risk), signals };
};
