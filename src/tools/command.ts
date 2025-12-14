import { spawn, ChildProcess } from 'child_process';
import { platform } from 'os';
import { loadConfig } from '../config/index.js';

interface BackgroundProcess {
  id: string;
  command: string;
  process: ChildProcess;
  output: string;
  exitCode: number | null;
  startedAt: Date;
}

const processes = new Map<string, BackgroundProcess>();
let procCounter = 0;

const genId = (): string => `proc_${(++procCounter).toString(36)}${Date.now().toString(36).slice(-4)}`;

export const executeCommand = async (command: string, cwd: string): Promise<string> => {
  const config = loadConfig();
  const timeoutMs = config.commandTimeout * 1000;
  const isWin = platform() === 'win32';
  const shell = isWin ? 'cmd.exe' : '/bin/sh';
  const args = isWin ? ['/c', command] : ['-c', command];

  return new Promise(resolve => {
    let output = '';
    let resolved = false;
    const proc = spawn(shell, args, { cwd, env: process.env });

    proc.stdout?.on('data', d => { output += d.toString(); });
    proc.stderr?.on('data', d => { output += d.toString(); });

    const timeout = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      const id = genId();
      processes.set(id, { id, command, process: proc, output, exitCode: null, startedAt: new Date() });
      proc.on('close', code => {
        const p = processes.get(id);
        if (p) { p.exitCode = code; p.output = output; }
      });
      resolve(`Command timed out after ${config.commandTimeout}s. Backgrounded as: ${id}`);
    }, timeoutMs);

    proc.on('close', code => {
      clearTimeout(timeout);
      if (resolved) return;
      resolved = true;
      resolve(code === 0 ? output || '(no output)' : `Exit code ${code}\n${output}`);
    });

    proc.on('error', err => {
      clearTimeout(timeout);
      if (resolved) return;
      resolved = true;
      resolve(`Error: ${err.message}`);
    });
  });
};

export const readBackgroundProcess = (id: string): string => {
  const proc = processes.get(id);
  if (!proc) return `Process not found: ${id}`;
  const status = proc.exitCode !== null ? `Exited (${proc.exitCode})` : 'Running';
  return `[${id}] ${status}\nCommand: ${proc.command}\n\n${proc.output || '(no output yet)'}`;
};

export const listBackgroundProcesses = (): string => {
  if (!processes.size) return 'No background processes';
  return [...processes.values()].map(p => {
    const status = p.exitCode !== null ? `Exited (${p.exitCode})` : 'Running';
    const age = Math.round((Date.now() - p.startedAt.getTime()) / 1000);
    return `${p.id}: ${status} (${age}s) - ${p.command.slice(0, 50)}${p.command.length > 50 ? '...' : ''}`;
  }).join('\n');
};

export const killBackgroundProcess = (id: string): string => {
  const proc = processes.get(id);
  if (!proc) return `Process not found: ${id}`;
  if (proc.exitCode !== null) return `Process already exited with code ${proc.exitCode}`;
  try {
    proc.process.kill();
    return `Process ${id} killed`;
  } catch (e) { return `Failed to kill process: ${(e as Error).message}`; }
};

export const ALLOWED_AUDIT_COMMANDS = [
  /^cat\s/, /^head\s/, /^tail\s/, /^ls\b/, /^dir\b/, /^tree\b/,
  /^git\s+(status|diff|log)\b/, /^npm\s+(test|run\s+build)\b/, /^type\s/,
];

export const isAuditAllowed = (cmd: string): boolean =>
  ALLOWED_AUDIT_COMMANDS.some(r => r.test(cmd.trim()));
