import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { JsonValue, Tool } from '../core/types.js';

const MAX_FILE_BYTES = 1_000_000;
const MAX_ENTRIES = 200;

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

export class LocalFileTools {
  private constructor(private readonly roots: string[]) {}

  static async create(roots: string[]): Promise<LocalFileTools> {
    if (!roots.length) throw new Error('At least one local file root is required');
    return new LocalFileTools(await Promise.all(roots.map(root => realpath(resolve(root)))));
  }

  private async allowed(input: unknown): Promise<string> {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new Error('path must be a non-empty string');
    const requested = resolve(input);
    const canonical = await realpath(requested);
    if (!this.roots.some(root => inside(canonical, root))) throw new Error('Path is outside LOCAL_FILE_ROOTS');
    return canonical;
  }

  tools(): Tool[] {
    return [
      {
        name: 'local_list', description: 'List files and directories inside explicitly authorized local roots. Read-only.',
        parameters: [{ name: 'path', type: 'string', description: 'Absolute path inside an authorized root.', required: true }],
        execute: async ({ path }) => {
          const directory = await this.allowed(path);
          if (!(await stat(directory)).isDirectory()) throw new Error('Path is not a directory');
          const entries = await readdir(directory, { withFileTypes: true });
          return { path: directory, entries: entries.slice(0, MAX_ENTRIES).map(item => ({ name: item.name, type: item.isDirectory() ? 'directory' : item.isFile() ? 'file' : 'other' })), truncated: entries.length > MAX_ENTRIES };
        },
      },
      {
        name: 'local_read', description: 'Read a UTF-8 text file inside explicitly authorized local roots. Read-only; binary and oversized files are rejected.',
        parameters: [{ name: 'path', type: 'string', description: 'Absolute path to a text file inside an authorized root.', required: true }],
        execute: async ({ path }) => {
          const file = await this.allowed(path); const info = await stat(file);
          if (!info.isFile()) throw new Error('Path is not a file');
          if (info.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes`);
          const buffer = await readFile(file);
          if (buffer.includes(0)) throw new Error('Binary files are not supported');
          return { path: file, content: buffer.toString('utf8'), bytes: info.size };
        },
      },
      {
        name: 'local_search', description: 'Search UTF-8 files by filename or text inside an authorized local directory. Read-only and bounded.',
        parameters: [
          { name: 'path', type: 'string', description: 'Absolute directory path inside an authorized root.', required: true },
          { name: 'query', type: 'string', description: 'Case-insensitive text to find.', required: true },
        ],
        execute: async ({ path, query }, context) => {
          if (typeof query !== 'string' || !query.trim() || query.length > 500) throw new Error('query must contain 1 to 500 characters');
          const directory = await this.allowed(path); const matches: JsonValue[] = []; let visited = 0;
          const walk = async (current: string): Promise<void> => {
            for (const item of await readdir(current, { withFileTypes: true })) {
              context.signal.throwIfAborted(); if (visited++ >= 500 || matches.length >= 50) return;
              const candidate = resolve(current, item.name);
              if (item.isDirectory()) await walk(candidate);
              else if (item.isFile()) {
                const info = await stat(candidate); if (info.size > MAX_FILE_BYTES) continue;
                if (item.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())) { matches.push({ path: candidate, match: 'filename' }); continue; }
                const buffer = await readFile(candidate); if (buffer.includes(0)) continue;
                const lines = buffer.toString('utf8').split(/\r?\n/u);
                const index = lines.findIndex(line => line.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
                if (index >= 0) matches.push({ path: candidate, line: index + 1, preview: lines[index]!.slice(0, 300) });
              }
            }
          };
          await walk(directory); return { query, matches, truncated: visited >= 500 || matches.length >= 50 };
        },
      },
    ];
  }
}
