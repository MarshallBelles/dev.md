import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { spawn } from 'child_process';
import * as readline from 'readline';

export interface Config {
  apiUrl: string;
  apiKey: string;
  model: string;
  maxContextTokens: number;
  commandTimeout: number;
  maxRetries: number;
  maxRetriesAutomated: number;
  maxLoops: number;
  sessionRetentionDays: number;
}

const DEFAULTS: Config = {
  apiUrl: 'http://localhost:8005/v1',
  apiKey: '',
  model: 'devstral-small-2507',
  maxContextTokens: 131072,
  commandTimeout: 30,
  maxRetries: 3,
  maxRetriesAutomated: 10,
  maxLoops: 1000,
  sessionRetentionDays: 30,
};

export const getConfigDir = (): string => {
  const p = platform();
  if (p === 'win32') return join(process.env.APPDATA || homedir(), 'dev-agent');
  if (p === 'darwin') return join(homedir(), 'Library', 'Application Support', 'dev-agent');
  return join(homedir(), '.dev-agent');
};

export const getConfigPath = (): string => join(getConfigDir(), 'config.json');
export const getSessionsDir = (): string => join(getConfigDir(), 'sessions');
export const configExists = (): boolean => existsSync(getConfigPath());

export const ensureDirs = (): void => {
  const configDir = getConfigDir();
  const sessionsDir = getSessionsDir();
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  if (!existsSync(sessionsDir)) mkdirSync(sessionsDir, { recursive: true });
};

export const loadConfig = (): Config => {
  ensureDirs();
  const path = getConfigPath();
  if (!existsSync(path)) {
    writeFileSync(path, JSON.stringify(DEFAULTS, null, 2));
    return { ...DEFAULTS };
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path, 'utf-8')) };
  } catch {
    return { ...DEFAULTS };
  }
};

export const saveConfig = (config: Config): void => {
  ensureDirs();
  writeFileSync(getConfigPath(), JSON.stringify(config, null, 2));
};

export const openConfigInEditor = (): void => {
  ensureDirs();
  const path = getConfigPath();
  if (!existsSync(path)) writeFileSync(path, JSON.stringify(DEFAULTS, null, 2));
  const p = platform();
  const cmd = p === 'win32' ? 'notepad' : p === 'darwin' ? 'open' : 'xdg-open';
  spawn(cmd, [path], { detached: true, stdio: 'ignore' }).unref();
};

const ask = (rl: readline.Interface, question: string, defaultVal?: string): Promise<string> => {
  const prompt = defaultVal ? `${question} (${defaultVal}): ` : `${question}: `;
  return new Promise(resolve => {
    rl.question(prompt, answer => resolve(answer.trim() || defaultVal || ''));
  });
};

export const runFirstTimeSetup = async (): Promise<Config> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log('\n  Welcome to dev.md!\n');
  console.log('  First-time setup - configure your AI endpoint.\n');

  const apiUrl = await ask(rl, '  API URL', DEFAULTS.apiUrl);
  const apiKey = await ask(rl, '  API Key (leave blank if none)');
  const model = await ask(rl, '  Model name', DEFAULTS.model);
  const maxContextStr = await ask(rl, '  Max context tokens', String(DEFAULTS.maxContextTokens));
  const maxContextTokens = parseInt(maxContextStr, 10) || DEFAULTS.maxContextTokens;

  rl.close();

  const config: Config = { ...DEFAULTS, apiUrl, apiKey, model, maxContextTokens };
  ensureDirs();
  saveConfig(config);

  console.log(`\n  Config saved to: ${getConfigPath()}`);
  console.log('  Run `dev config` anytime to edit.\n');

  return config;
};
