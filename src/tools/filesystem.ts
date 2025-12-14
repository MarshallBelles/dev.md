import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { dirname, join, relative, basename } from 'path';
import { glob } from 'glob';

export const listDirectory = async (pathOrGlob: string, cwd: string): Promise<string> => {
  const isGlob = pathOrGlob.includes('*');
  if (isGlob) {
    const matches = await glob(pathOrGlob, { cwd, nodir: false });
    if (!matches.length) return 'No matches found';
    return formatTree(matches);
  }
  const target = pathOrGlob.startsWith('/') || pathOrGlob.match(/^[a-zA-Z]:/) ? pathOrGlob : join(cwd, pathOrGlob);
  if (!existsSync(target)) return `Directory not found: ${target}`;
  if (!statSync(target).isDirectory()) return `Not a directory: ${target}`;
  const entries = readdirSync(target, { withFileTypes: true });
  const lines = entries.map(e => `${e.isDirectory() ? '📁' : '📄'} ${e.name}`);
  return lines.join('\n') || '(empty directory)';
};

const formatTree = (paths: string[]): string => {
  const sorted = paths.sort();
  const tree: Record<string, any> = {};
  for (const p of sorted) {
    const parts = p.split(/[/\\]/);
    let node = tree;
    for (const part of parts) {
      node[part] = node[part] || {};
      node = node[part];
    }
  }
  const render = (node: Record<string, any>, prefix = ''): string[] => {
    const keys = Object.keys(node);
    return keys.flatMap((k, i) => {
      const isLast = i === keys.length - 1;
      const connector = isLast ? '└── ' : '├── ';
      const childPrefix = isLast ? '    ' : '│   ';
      const children = Object.keys(node[k]).length ? render(node[k], prefix + childPrefix) : [];
      return [`${prefix}${connector}${k}`, ...children];
    });
  };
  return render(tree).join('\n');
};

export const readFile = (path: string, cwd: string): string => {
  const target = path.startsWith('/') || path.match(/^[a-zA-Z]:/) ? path : join(cwd, path);
  if (!existsSync(target)) return `File not found: ${target}`;
  try { return readFileSync(target, 'utf-8'); }
  catch (e) { return `Error reading file: ${(e as Error).message}`; }
};

export const writeFile = (path: string, content: string, cwd: string): string => {
  const target = path.startsWith('/') || path.match(/^[a-zA-Z]:/) ? path : join(cwd, path);
  try {
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
    return `File written: ${target}`;
  } catch (e) { return `Error writing file: ${(e as Error).message}`; }
};

export const findAndReplace = (path: string, find: string, replace: string, cwd: string): string => {
  const target = path.startsWith('/') || path.match(/^[a-zA-Z]:/) ? path : join(cwd, path);
  if (!existsSync(target)) return `File not found: ${target}`;
  try {
    const content = readFileSync(target, 'utf-8');
    if (!content.includes(find)) return `Pattern not found in file: ${target}`;
    const updated = content.split(find).join(replace);
    writeFileSync(target, updated);
    const count = (content.match(new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    return `Replaced ${count} occurrence(s) in: ${target}`;
  } catch (e) { return `Error: ${(e as Error).message}`; }
};
