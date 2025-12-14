import { execSync, spawn, ChildProcess } from 'child_process';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// Each test file should use a unique port to allow parallel execution
export const getTestPort = (offset = 0): number => 18765 + offset;
export const getTestApiUrl = (port: number): string => `http://localhost:${port}/v1`;

export interface TestContext {
  tempDir: string;
  configDir: string;
  baseConfigDir: string;
  cleanup: () => void;
}

export const createTestContext = (port: number): TestContext => {
  const id = randomUUID().slice(0, 8);
  const tempDir = join(tmpdir(), `dev-md-test-${id}`);
  const baseConfigDir = join(tmpdir(), `dev-md-config-${id}`);
  // The actual config dir is baseConfigDir/dev-agent (matches getConfigDir logic)
  const configDir = join(baseConfigDir, 'dev-agent');
  mkdirSync(tempDir, { recursive: true });
  mkdirSync(configDir, { recursive: true });
  mkdirSync(join(configDir, 'sessions'), { recursive: true });

  const config = {
    apiUrl: getTestApiUrl(port),
    apiKey: '',
    model: 'test-model',
    maxContextTokens: 131072,
    commandTimeout: 10,
    maxRetries: 2,
    maxRetriesAutomated: 3,
    maxLoops: 50,
    sessionRetentionDays: 30,
  };
  writeFileSync(join(configDir, 'config.json'), JSON.stringify(config, null, 2));

  return {
    tempDir,
    configDir,
    baseConfigDir,
    cleanup: () => {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(baseConfigDir, { recursive: true, force: true });
    },
  };
};

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  sessionId?: string;
}

const CLI_PATH = join(process.cwd(), 'dist', 'index.js');

export const runCLI = async (
  args: string[],
  ctx: TestContext,
  options: { timeout?: number; input?: string } = {}
): Promise<RunResult> => {
  const { timeout = 30000, input } = options;

  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      APPDATA: ctx.baseConfigDir,
      HOME: ctx.baseConfigDir,
      XDG_CONFIG_HOME: ctx.baseConfigDir,
    };

    const proc = spawn('node', [CLI_PATH, ...args], {
      cwd: ctx.tempDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());

    if (input) {
      proc.stdin.write(input);
      proc.stdin.end();
    }

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`CLI timeout after ${timeout}ms`));
    }, timeout);

    proc.on('close', code => {
      clearTimeout(timer);
      const sessionMatch = stdout.match(/Session:\s*([a-f0-9-]+)/i) ||
                          stdout.match(/Resumed:\s*([a-f0-9-]+)/i);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? 1,
        sessionId: sessionMatch?.[1],
      });
    });

    proc.on('error', err => {
      clearTimeout(timer);
      reject(err);
    });
  });
};

export const readTestFile = (ctx: TestContext, path: string): string | null => {
  const fullPath = join(ctx.tempDir, path);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf-8');
};

export const writeTestFile = (ctx: TestContext, path: string, content: string): void => {
  const fullPath = join(ctx.tempDir, path);
  const dir = join(fullPath, '..');
  mkdirSync(dir, { recursive: true });
  writeFileSync(fullPath, content);
};

export const testFileExists = (ctx: TestContext, path: string): boolean => {
  return existsSync(join(ctx.tempDir, path));
};

export const getSessionFile = (ctx: TestContext, sessionId: string): any | null => {
  const path = join(ctx.configDir, 'sessions', `${sessionId}.json`);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return null;
  }
};

export const listSessionFiles = (ctx: TestContext): string[] => {
  const dir = join(ctx.configDir, 'sessions');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f: string) => f.endsWith('.json') && f !== 'directory-map.json');
};

export const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));
