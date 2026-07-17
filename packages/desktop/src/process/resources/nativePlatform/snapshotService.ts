import { access, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  CompareResult,
  FileChangeInfo,
  FileChangeOperation,
  SnapshotInfo,
} from '@/common/types/platform/fileSnapshot';

const SKIP = new Set(['.git', 'node_modules', '.tomny']);
const exists = async (filePath: string): Promise<boolean> =>
  access(filePath).then(
    () => true,
    () => false
  );
const relative = (workspace: string, filePath: string): string =>
  path.relative(workspace, filePath).replace(/\\/g, '/');
const resolveInside = (workspace: string, filePath: string): string => {
  const root = path.resolve(workspace);
  const target = path.resolve(root, filePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('File escapes workspace.');
  return target;
};

type MemorySnapshot = { baseline: Map<string, Buffer>; staged: Set<string> };

const capture = async (workspace: string): Promise<Map<string, Buffer>> => {
  const result = new Map<string, Buffer>();
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name) || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) result.set(relative(workspace, target), await readFile(target));
    }
  };
  await visit(workspace);
  return result;
};

const change = (workspace: string, file: string, operation: FileChangeOperation): FileChangeInfo => ({
  file_path: path.join(workspace, file),
  relativePath: file,
  operation,
});

export class NativeSnapshotService {
  private readonly memory = new Map<string, MemorySnapshot>();
  private git(workspace: string): SimpleGit {
    return simpleGit({ baseDir: workspace });
  }
  private async isGit(workspace: string): Promise<boolean> {
    return this.git(workspace).checkIsRepo();
  }

  async init(workspaceInput: string): Promise<SnapshotInfo> {
    const workspace = path.resolve(workspaceInput);
    if (await this.isGit(workspace))
      return { mode: 'git-repo', branch: (await this.git(workspace).branch()).current || null };
    this.memory.set(workspace, { baseline: await capture(workspace), staged: new Set() });
    return { mode: 'snapshot', branch: null };
  }
  async getInfo(workspace: string): Promise<SnapshotInfo> {
    const root = path.resolve(workspace);
    if (await this.isGit(root)) return { mode: 'git-repo', branch: (await this.git(root).branch()).current || null };
    if (!this.memory.has(root)) await this.init(root);
    return { mode: 'snapshot', branch: null };
  }
  async compare(workspaceInput: string): Promise<CompareResult> {
    const workspace = path.resolve(workspaceInput);
    if (await this.isGit(workspace)) {
      const status = await this.git(workspace).status();
      const staged: FileChangeInfo[] = [];
      const unstaged: FileChangeInfo[] = [];
      for (const file of status.files) {
        const operation: FileChangeOperation =
          file.index === '?' || file.working_dir === '?'
            ? 'create'
            : file.index === 'D' || file.working_dir === 'D'
              ? 'delete'
              : 'modify';
        if (file.index !== ' ' && file.index !== '?') staged.push(change(workspace, file.path, operation));
        if (file.working_dir !== ' ' || file.index === '?') unstaged.push(change(workspace, file.path, operation));
      }
      return { staged, unstaged };
    }
    const snapshot = this.memory.get(workspace) ?? { baseline: await capture(workspace), staged: new Set<string>() };
    this.memory.set(workspace, snapshot);
    const current = await capture(workspace);
    const files = new Set([...snapshot.baseline.keys(), ...current.keys()]);
    const staged: FileChangeInfo[] = [];
    const unstaged: FileChangeInfo[] = [];
    for (const file of files) {
      const before = snapshot.baseline.get(file);
      const after = current.get(file);
      if (before && after && before.equals(after)) continue;
      const operation: FileChangeOperation = before ? (after ? 'modify' : 'delete') : 'create';
      (snapshot.staged.has(file) ? staged : unstaged).push(change(workspace, file, operation));
    }
    return { staged, unstaged };
  }
  async baseline(workspaceInput: string, filePath: string): Promise<string | null> {
    const workspace = path.resolve(workspaceInput);
    const file = relative(workspace, resolveInside(workspace, filePath));
    if (await this.isGit(workspace))
      return this.git(workspace)
        .show([`HEAD:${file}`])
        .catch(() => null);
    const snapshot = this.memory.get(workspace);
    const value = snapshot?.baseline.get(file);
    return value ? value.toString('utf8') : null;
  }
  async stage(workspaceInput: string, filePath?: string): Promise<void> {
    const workspace = path.resolve(workspaceInput);
    if (await this.isGit(workspace)) {
      await this.git(workspace).add(filePath ? [relative(workspace, resolveInside(workspace, filePath))] : ['-A']);
      return;
    }
    const snapshot = this.requireMemory(workspace);
    if (filePath) snapshot.staged.add(relative(workspace, resolveInside(workspace, filePath)));
    else for (const item of [...(await this.compare(workspace)).unstaged]) snapshot.staged.add(item.relativePath);
  }
  async unstage(workspaceInput: string, filePath?: string): Promise<void> {
    const workspace = path.resolve(workspaceInput);
    if (await this.isGit(workspace)) {
      await this.git(workspace).reset([
        'HEAD',
        '--',
        ...(filePath ? [relative(workspace, resolveInside(workspace, filePath))] : ['.']),
      ]);
      return;
    }
    const snapshot = this.requireMemory(workspace);
    if (filePath) snapshot.staged.delete(relative(workspace, resolveInside(workspace, filePath)));
    else snapshot.staged.clear();
  }
  async discard(workspaceInput: string, filePath: string, operation: FileChangeOperation): Promise<void> {
    const workspace = path.resolve(workspaceInput);
    const target = resolveInside(workspace, filePath);
    const file = relative(workspace, target);
    if (await this.isGit(workspace)) {
      if (operation === 'create') await rm(target, { force: true, recursive: true });
      else await this.git(workspace).checkout(['--', file]);
      return;
    }
    const snapshot = this.requireMemory(workspace);
    const baseline = snapshot.baseline.get(file);
    if (!baseline) await rm(target, { force: true, recursive: true });
    else {
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, baseline);
    }
    snapshot.staged.delete(file);
  }
  async reset(workspace: string, filePath: string): Promise<void> {
    await this.unstage(workspace, filePath);
  }
  async branches(workspace: string): Promise<string[]> {
    return (await this.git(path.resolve(workspace)).branchLocal()).all;
  }
  dispose(workspace: string): void {
    this.memory.delete(path.resolve(workspace));
  }
  private requireMemory(workspace: string): MemorySnapshot {
    const snapshot = this.memory.get(workspace);
    if (!snapshot) throw new Error('Snapshot is not initialized.');
    return snapshot;
  }
}
