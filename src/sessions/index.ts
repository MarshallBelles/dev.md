import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { v4 as uuid } from 'uuid';
import { getSessionsDir, ensureDirs, loadConfig } from '../config/index.js';

export interface Message { role: 'system' | 'user' | 'assistant'; content: string }
export interface TaskItem { status: 'pending' | 'in-progress' | 'complete'; text: string }
export interface Compression { timestamp: string; tokensBefore: number; tokensAfter: number }

export interface Session {
  id: string;
  createdAt: string;
  updatedAt: string;
  workingDirectory: string;
  originalPrompt: string;
  taskList: TaskItem[];
  history: Message[];
  totalTokens: number;
  compressions: Compression[];
}

const getMapPath = (): string => join(getSessionsDir(), 'directory-map.json');

const loadDirMap = (): Record<string, string> => {
  const path = getMapPath();
  if (!existsSync(path)) return {};
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return {}; }
};

const saveDirMap = (map: Record<string, string>): void => {
  writeFileSync(getMapPath(), JSON.stringify(map, null, 2));
};

export const createSession = (workingDirectory: string, originalPrompt: string): Session => {
  ensureDirs();
  const session: Session = {
    id: uuid(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    workingDirectory,
    originalPrompt,
    taskList: [],
    history: [],
    totalTokens: 0,
    compressions: [],
  };
  saveSession(session);
  const map = loadDirMap();
  map[workingDirectory] = session.id;
  saveDirMap(map);
  return session;
};

export const saveSession = (session: Session): void => {
  ensureDirs();
  session.updatedAt = new Date().toISOString();
  writeFileSync(join(getSessionsDir(), `${session.id}.json`), JSON.stringify(session, null, 2));
  const map = loadDirMap();
  map[session.workingDirectory] = session.id;
  saveDirMap(map);
};

export const loadSession = (id: string): Session | null => {
  const path = join(getSessionsDir(), `${id}.json`);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
};

export const getLastSessionForDir = (dir: string): Session | null => {
  const map = loadDirMap();
  const id = map[dir];
  return id ? loadSession(id) : null;
};

export const listSessions = (): Session[] => {
  ensureDirs();
  const dir = getSessionsDir();
  return readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'directory-map.json')
    .map(f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')); } catch { return null; } })
    .filter((s): s is Session => s !== null)
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
};

export const cleanOldSessions = (): number => {
  const config = loadConfig();
  const cutoff = Date.now() - config.sessionRetentionDays * 24 * 60 * 60 * 1000;
  const dir = getSessionsDir();
  let count = 0;
  readdirSync(dir)
    .filter(f => f.endsWith('.json') && f !== 'directory-map.json')
    .forEach(f => {
      try {
        const session: Session = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        if (new Date(session.updatedAt).getTime() < cutoff) {
          unlinkSync(join(dir, f));
          count++;
        }
      } catch { /* ignore */ }
    });
  return count;
};

export const estimateTokens = (messages: Message[]): number => {
  return Math.ceil(messages.reduce((acc, m) => acc + m.content.length, 0) / 4);
};
