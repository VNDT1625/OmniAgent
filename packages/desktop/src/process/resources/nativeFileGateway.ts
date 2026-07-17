import { copyFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IDirOrFile, IFileMetadata, IWorkspaceFlatFile } from '@/common/adapter/ipcBridge';
import { readDirectoryRecursive } from '@process/utils/utils';

const MIME_BY_EXTENSION: Record<string, string> = {
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
};
const mimeFor = (filePath: string): string =>
  MIME_BY_EXTENSION[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

export class NativeFileGateway {
  async getFilesByDir(input: { dir: string; root: string }): Promise<IDirOrFile[]> {
    const tree = await readDirectoryRecursive(path.resolve(input.dir), {
      root: path.resolve(input.root),
      maxDepth: 20,
    });
    return tree ? [tree] : [];
  }
  async listWorkspaceFiles(root: string): Promise<IWorkspaceFlatFile[]> {
    const workspace = path.resolve(root);
    const result: IWorkspaceFlatFile[] = [];
    const visit = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        const fullPath = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(fullPath);
        else if (entry.isFile())
          result.push({
            name: entry.name,
            fullPath,
            relativePath: path.relative(workspace, fullPath).replace(/\\/g, '/'),
          });
      }
    };
    await visit(workspace);
    return result;
  }
  async readText(filePath: string): Promise<string | null> {
    try {
      return await readFile(path.resolve(filePath), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async readBase64(filePath: string): Promise<string | null> {
    try {
      return (await readFile(path.resolve(filePath))).toString('base64');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  async imageDataUrl(filePath: string): Promise<string | null> {
    const base64 = await this.readBase64(filePath);
    return base64 === null ? null : `data:${mimeFor(filePath)};base64,${base64}`;
  }
  async fetchRemoteImage(url: string): Promise<string> {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only HTTP(S) image URLs are supported.');
    const response = await fetch(parsed, { redirect: 'follow' });
    if (!response.ok) throw new Error(`Image request failed (${response.status}).`);
    const contentType = response.headers.get('content-type')?.split(';')[0] || 'application/octet-stream';
    return `data:${contentType};base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`;
  }
  async createTempFile(fileName: string): Promise<string> {
    const safeName = path.basename(fileName.trim() || 'attachment.tmp');
    const target = path.join(await mkdtemp(path.join(os.tmpdir(), 'tomny-')), safeName);
    await writeFile(target, '');
    return target;
  }
  async writeText(filePath: string, data: string): Promise<boolean> {
    const target = path.resolve(filePath);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data, 'utf8');
    return true;
  }
  async metadata(filePath: string): Promise<IFileMetadata> {
    const target = path.resolve(filePath);
    const info = await stat(target);
    return {
      name: path.basename(target),
      path: target,
      size: info.size,
      type: info.isDirectory() ? 'directory' : mimeFor(target),
      lastModified: info.mtimeMs,
      isDirectory: info.isDirectory(),
    };
  }
  async copyToWorkspace(input: {
    file_paths: string[];
    workspace: string;
    source_root?: string;
  }): Promise<{ copied_files: string[]; failed_files?: Array<{ path: string; error: string }> }> {
    const workspace = path.resolve(input.workspace);
    await mkdir(workspace, { recursive: true });
    const copied_files: string[] = [];
    const failed_files: Array<{ path: string; error: string }> = [];
    for (const sourceInput of input.file_paths) {
      try {
        const source = path.resolve(sourceInput);
        const relative = input.source_root
          ? path.relative(path.resolve(input.source_root), source)
          : path.basename(source);
        if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Source is outside source_root.');
        const destination = path.resolve(workspace, relative);
        if (destination !== workspace && !destination.startsWith(`${workspace}${path.sep}`))
          throw new Error('Destination escapes workspace.');
        await mkdir(path.dirname(destination), { recursive: true });
        await copyFile(source, destination);
        copied_files.push(destination);
      } catch (error) {
        failed_files.push({ path: sourceInput, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return { copied_files, ...(failed_files.length > 0 ? { failed_files } : {}) };
  }
  async remove(filePath: string): Promise<void> {
    await rm(path.resolve(filePath), { recursive: true, force: true });
  }
  async rename(filePath: string, newName: string): Promise<{ new_path: string }> {
    const source = path.resolve(filePath);
    const safeName = path.basename(newName);
    if (!safeName || safeName !== newName) throw new Error('new_name must be a single file name.');
    const destination = path.join(path.dirname(source), safeName);
    await rename(source, destination);
    return { new_path: destination };
  }
}
