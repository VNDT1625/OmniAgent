import { watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

export type ZipEntry = { name: string; content?: string | Uint8Array; source_path?: string };
export type FileChangeEvent = { file_path: string; event_type: string };

const safeArchiveName = (name: string): string => {
  const normalized = name.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.split('/').includes('..')) throw new Error(`Unsafe archive entry: ${name}`);
  return normalized;
};

export class NativeZipService {
  private readonly cancelled = new Set<string>();
  private readonly active = new Set<string>();
  async create(input: { path: string; request_id?: string; files: ZipEntry[] }): Promise<boolean> {
    const requestId = input.request_id?.trim();
    if (requestId && this.active.has(requestId)) throw new Error(`ZIP request "${requestId}" is already running.`);
    if (requestId) {
      this.cancelled.delete(requestId);
      this.active.add(requestId);
    }
    const target = path.resolve(input.path);
    const temporary = `${target}.${requestId || process.pid}.tmp`;
    try {
      const archive = new JSZip();
      for (const entry of input.files) {
        this.throwIfCancelled(requestId);
        const name = safeArchiveName(entry.name);
        if (entry.source_path) archive.file(name, await readFile(path.resolve(entry.source_path)));
        else archive.file(name, entry.content ?? '');
      }
      const data = await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }, () =>
        this.throwIfCancelled(requestId)
      );
      this.throwIfCancelled(requestId);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(temporary, data);
      await rename(temporary, target);
      return true;
    } finally {
      if (requestId) {
        this.active.delete(requestId);
        this.cancelled.delete(requestId);
      }
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }
  cancel(requestId: string): boolean {
    if (!this.active.has(requestId)) return false;
    this.cancelled.add(requestId);
    return true;
  }
  private throwIfCancelled(requestId?: string): void {
    if (requestId && this.cancelled.has(requestId)) throw new Error('ZIP creation cancelled.');
  }
}

export class NativeWatchService {
  private readonly watchers = new Map<string, FSWatcher>();
  start(filePath: string, listener: (event: FileChangeEvent) => void): void {
    const target = path.resolve(filePath);
    if (this.watchers.has(target)) return;
    const watcher = watch(target, { persistent: false }, (eventType, filename) => {
      listener({ file_path: filename ? path.resolve(target, filename.toString()) : target, event_type: eventType });
    });
    watcher.once('error', () => this.stop(target));
    this.watchers.set(target, watcher);
  }
  stop(filePath: string): void {
    const target = path.resolve(filePath);
    this.watchers.get(target)?.close();
    this.watchers.delete(target);
  }
  stopAll(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
}

const OFFICE_EXTENSIONS = new Set(['.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pdf']);
export class NativeOfficeWatchService {
  private readonly watchService = new NativeWatchService();
  private readonly known = new Map<string, Set<string>>();
  async start(workspaceInput: string, listener: (filePath: string, workspace: string) => void): Promise<void> {
    const workspace = path.resolve(workspaceInput);
    if (this.known.has(workspace)) return;
    const known = new Set<string>();
    this.known.set(workspace, known);
    this.watchService.start(workspace, async ({ file_path, event_type }) => {
      if (event_type !== 'rename' || !OFFICE_EXTENSIONS.has(path.extname(file_path).toLowerCase())) return;
      try {
        if (!(await stat(file_path)).isFile() || known.has(file_path)) return;
        known.add(file_path);
        listener(file_path, workspace);
      } catch {
        known.delete(file_path);
      }
    });
  }
  stop(workspace: string): void {
    const resolved = path.resolve(workspace);
    this.watchService.stop(resolved);
    this.known.delete(resolved);
  }
}
