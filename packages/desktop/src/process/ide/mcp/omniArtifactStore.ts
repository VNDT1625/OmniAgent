/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Session-scoped artifact intake for the Omni MCP gateway.
 *
 * The ChatGPT connector can pass a local temp-file path instead of embedding a
 * long text/media payload directly in tool arguments. This store validates the
 * file, records small metadata, stores text artifacts under `.omni/artifacts`,
 * and applies imported text through safe workspace-bound operations.
 */

import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { writeTextFileWithMtui, type MtuiResponse } from '@process/terminal/mtuiBridge';

const execFileAsync = promisify(execFile);

const TEXT_EXTENSIONS = new Set([
  '.txt',
  '.md',
  '.json',
  '.patch',
  '.diff',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.css',
  '.html',
  '.yml',
  '.yaml',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg']);
const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov']);
const ALLOWED_ASSET_DIRS = ['public/', 'assets/', 'packages/desktop/src/renderer/assets/', 'docs/assets/'] as const;

const DEFAULT_TEXT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
const PREVIEW_CHARS = 1_200;
const DIFF_PREVIEW_CHARS = 8_000;
const CONNECTOR_FILE_UNRESOLVED = 'Uploaded file was not resolved by connector runtime';

export type ArtifactPurpose = 'snippet' | 'patch' | 'prompt' | 'codemod' | 'spec';
export type ArtifactEditMode = 'replace_anchor' | 'insert_before' | 'insert_after' | 'apply_unified_diff';
export type MediaKind = 'image' | 'video';

export type ArtifactFileObject = {
  path?: string;
  file_id?: string;
  fileId?: string;
  download_url?: string;
  downloadUrl?: string;
  file_name?: string;
  fileName?: string;
  name?: string;
  mime_type?: string;
};

export type ArtifactFileInput = string | ArtifactFileObject;

export type ImportedArtifact = {
  artifactId: string;
  sessionId: string;
  kind: 'text';
  purpose: ArtifactPurpose;
  size: number;
  sha256: string;
  createdAt: string;
  storedPath: string;
  preview: string;
};

export type ImportTextResult = Omit<ImportedArtifact, 'sessionId' | 'kind' | 'storedPath' | 'createdAt'> & {
  createdAt: string;
};

export type ApplyArtifactEditResult = {
  ok: boolean;
  targetPath: string;
  changed: boolean;
  diffPreview: string;
  backupId?: string;
  undoHint?: string;
};

export type ImportMediaAssetResult = {
  ok: true;
  destPath: string;
  size: number;
  sha256: string;
  mime: string;
  durationSeconds?: number;
  warning?: string;
};

export type ArtifactSummary = {
  artifactId: string;
  kind: 'text';
  purpose: ArtifactPurpose;
  size: number;
  sha256: string;
  createdAt: string;
};

export type OmniArtifactStoreDeps = {
  rootPath: string;
  now?: () => Date;
  newId?: () => string;
  writeTextFile?: (filePath: string, data: string) => Promise<MtuiResponse>;
  runGitApply?: (
    rootPath: string,
    args: string[],
    diff: string
  ) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  probeVideoDuration?: (filePath: string) => Promise<number | undefined>;
  resolveInputFile?: (file: ArtifactFileInput) => Promise<string | undefined>;
};

export type OmniArtifactStore = {
  importText: (input: {
    sessionId: string;
    file: ArtifactFileInput;
    purpose: ArtifactPurpose;
    maxBytes?: number;
  }) => Promise<ImportTextResult>;
  applyEdit: (input: {
    sessionId: string;
    artifactId: string;
    targetPath: string;
    mode: ArtifactEditMode;
    anchor?: string;
    dryRun?: boolean;
  }) => Promise<ApplyArtifactEditResult>;
  importMediaAsset: (input: {
    file: ArtifactFileInput;
    destPath: string;
    kind: MediaKind;
    overwrite?: boolean;
  }) => Promise<ImportMediaAssetResult>;
  list: (sessionId?: string) => ArtifactSummary[];
  delete: (sessionId: string | undefined, artifactId: string) => Promise<boolean>;
};

const normalizeRel = (value: string): string => value.replace(/\\/g, '/').replace(/^\/+/, '');

const isConnectorMountPath = (value: string): boolean => /^\/mnt\/data(?:\/|$)/i.test(value.replace(/\\/g, '/'));

const isLikelyFileReference = (value: string): boolean => /^file[_-][A-Za-z0-9_-]+$/.test(value.trim());

const hasTraversalSegment = (value: string): boolean => value.replace(/\\/g, '/').split('/').includes('..');

const isWithin = (rootPath: string, candidate: string): boolean => {
  const rel = path.relative(rootPath, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};

const resolveWorkspaceFile = (rootPath: string, targetPath: string): string => {
  const root = path.resolve(rootPath);
  const fullPath = path.resolve(root, targetPath);
  if (!isWithin(root, fullPath)) throw new Error('targetPath must stay inside the workspace root.');
  return fullPath;
};

const resolveAssetDest = (rootPath: string, destPath: string): { fullPath: string; relPath: string } => {
  const fullPath = resolveWorkspaceFile(rootPath, destPath);
  const relPath = normalizeRel(path.relative(path.resolve(rootPath), fullPath));
  const allowed = ALLOWED_ASSET_DIRS.some((dir) => relPath === dir.slice(0, -1) || relPath.startsWith(dir));
  if (!allowed) {
    throw new Error(`destPath must be under one of: ${ALLOWED_ASSET_DIRS.join(', ')}`);
  }
  return { fullPath, relPath };
};

const sha256 = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

const clipped = (text: string, max = PREVIEW_CHARS): string =>
  text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;

const countMatches = (text: string, anchor: string): number => {
  if (anchor.length === 0) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(anchor, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + anchor.length;
  }
};

const renderDiffPreview = (targetPath: string, oldText: string, newText: string): string => {
  if (oldText === newText) return `No changes for ${targetPath}.`;
  return clipped(
    [`--- ${targetPath}`, `+++ ${targetPath}`, '@@ artifact edit @@', '- ' + oldText, '+ ' + newText].join('\n'),
    DIFF_PREVIEW_CHARS
  );
};

const mimeFor = (ext: string, kind: MediaKind): string => {
  if (kind === 'video') {
    if (ext === '.webm') return 'video/webm';
    if (ext === '.mov') return 'video/quicktime';
    return 'video/mp4';
  }
  if (ext === '.svg') return 'image/svg+xml';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
};

const defaultGitApply = async (
  rootPath: string,
  args: string[],
  diff: string
): Promise<{ ok: boolean; stdout: string; stderr: string }> => {
  return new Promise((resolve) => {
    const child = spawn('git', ['apply', ...args], {
      cwd: rootPath,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, stdout, stderr: stderr || 'git apply timed out.' });
    }, 30_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: stderr || error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
    child.stdin?.end(diff);
  });
};

const defaultProbeVideoDuration = async (filePath: string): Promise<number | undefined> => {
  try {
    const result = await execFileAsync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filePath],
      { timeout: 5_000, windowsHide: true, maxBuffer: 64 * 1024 }
    );
    const duration = Number(result.stdout.trim());
    return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
  } catch {
    return undefined;
  }
};

const fileObjectId = (file: ArtifactFileObject): string | undefined => {
  const id = file.file_id ?? file.fileId;
  return typeof id === 'string' && id.trim().length > 0 ? id.trim() : undefined;
};

const fileObjectDownloadUrl = (file: ArtifactFileObject): string | undefined => {
  const url = file.download_url ?? file.downloadUrl;
  return typeof url === 'string' && url.trim().length > 0 ? url.trim() : undefined;
};

const fileObjectName = (file: ArtifactFileObject): string | undefined => {
  const name = file.file_name ?? file.fileName ?? file.name;
  return typeof name === 'string' && name.trim().length > 0 ? name.trim() : undefined;
};

const localSourceExists = async (filePath: string): Promise<boolean> => {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
};

const downloadFileReference = async (rootPath: string, file: ArtifactFileObject, now: () => Date): Promise<string> => {
  const url = fileObjectDownloadUrl(file);
  if (!url) throw new Error(CONNECTOR_FILE_UNRESOLVED);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Uploaded file download failed with HTTP ${response.status}.`);
  const contentLength = Number(response.headers.get('content-length') ?? 0);
  if (contentLength > DEFAULT_VIDEO_MAX_BYTES) {
    throw new Error(`Uploaded file is ${contentLength} bytes; limit is ${DEFAULT_VIDEO_MAX_BYTES}.`);
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > DEFAULT_VIDEO_MAX_BYTES) {
    throw new Error(`Uploaded file is ${bytes.length} bytes; limit is ${DEFAULT_VIDEO_MAX_BYTES}.`);
  }

  const hintedName = fileObjectName(file);
  const urlPath = (() => {
    try {
      return new URL(url).pathname;
    } catch {
      return '';
    }
  })();
  const ext = path.extname(hintedName || urlPath).toLowerCase();
  const dir = path.join(rootPath, '.omni', 'artifacts', '_incoming');
  await mkdir(dir, { recursive: true });
  const idPart = fileObjectId(file) ?? sha256(`${url}:${now().toISOString()}`).slice(0, 24);
  const localPath = path.join(dir, `${idPart}${ext}`);
  await writeFile(localPath, bytes);
  return localPath;
};

const resolveDefaultInputFile = async (rootPath: string, file: ArtifactFileInput, now: () => Date): Promise<string> => {
  if (typeof file !== 'string') {
    if (typeof file.path === 'string' && file.path.trim().length > 0) {
      return resolveDefaultInputFile(rootPath, file.path, now);
    }
    if (fileObjectDownloadUrl(file)) return downloadFileReference(rootPath, file, now);
    throw new Error(CONNECTOR_FILE_UNRESOLVED);
  }

  const raw = file.trim();
  if (raw.length === 0) throw new Error('file must be a non-empty local path.');
  if (isLikelyFileReference(raw)) throw new Error(CONNECTOR_FILE_UNRESOLVED);
  if (isConnectorMountPath(raw)) throw new Error(`${CONNECTOR_FILE_UNRESOLVED}: ${raw}`);
  if (!path.isAbsolute(raw)) {
    if (hasTraversalSegment(raw)) throw new Error('file must not contain path traversal.');
    throw new Error('file must be an absolute local path or a connector-resolved file parameter.');
  }

  const resolved = path.resolve(raw);
  if (!(await localSourceExists(resolved))) throw new Error(`file does not exist: ${resolved}`);
  return resolved;
};

const diffTouchedFiles = (diff: string): string[] => {
  const paths = new Set<string>();
  for (const line of diff.split(/\r?\n/)) {
    if (!line.startsWith('--- ') && !line.startsWith('+++ ')) continue;
    const raw = line.slice(4).trim().split(/\s+/)[0];
    if (!raw || raw === '/dev/null') continue;
    const withoutPrefix = raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
    paths.add(normalizeRel(withoutPrefix));
  }
  return Array.from(paths);
};

export const createOmniArtifactStore = (deps: OmniArtifactStoreDeps): OmniArtifactStore => {
  const rootPath = path.resolve(deps.rootPath);
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? (() => `art_${randomBytes(12).toString('hex')}`);
  const writeTextFile = deps.writeTextFile ?? writeTextFileWithMtui;
  const runGitApply = deps.runGitApply ?? defaultGitApply;
  const probeVideoDuration = deps.probeVideoDuration ?? defaultProbeVideoDuration;
  const resolveInputFile = async (file: ArtifactFileInput): Promise<string> => {
    const resolved = deps.resolveInputFile
      ? await deps.resolveInputFile(file)
      : await resolveDefaultInputFile(rootPath, file, now);
    if (!resolved) throw new Error(CONNECTOR_FILE_UNRESOLVED);
    if (!(await localSourceExists(resolved))) throw new Error(`file does not exist: ${resolved}`);
    return path.resolve(resolved);
  };
  const artifacts = new Map<string, ImportedArtifact>();

  const artifactDir = (sessionId: string): string => path.join(rootPath, '.omni', 'artifacts', sessionId);

  const readArtifact = async (
    artifactId: string,
    sessionId: string
  ): Promise<{ meta: ImportedArtifact; content: string }> => {
    const meta = artifacts.get(artifactId);
    if (!meta) throw new Error(`Unknown artifactId: ${artifactId}`);
    if (meta.sessionId !== sessionId) throw new Error('artifactId does not belong to this session.');
    return { meta, content: await readFile(meta.storedPath, 'utf-8') };
  };

  return {
    importText: async ({ sessionId, file, purpose, maxBytes }) => {
      const sourcePath = await resolveInputFile(file);
      const ext = path.extname(sourcePath).toLowerCase();
      if (!TEXT_EXTENSIONS.has(ext)) throw new Error(`Unsupported text artifact extension: ${ext || '(none)'}`);
      const sourceStat = await stat(sourcePath);
      const limit = maxBytes && maxBytes > 0 ? maxBytes : DEFAULT_TEXT_MAX_BYTES;
      if (sourceStat.size > limit) throw new Error(`Text artifact is ${sourceStat.size} bytes; maxBytes is ${limit}.`);

      const content = await readFile(sourcePath, 'utf-8');
      const artifactId = newId();
      const dir = artifactDir(sessionId);
      await mkdir(dir, { recursive: true });
      const storedPath = path.join(dir, `${artifactId}.txt`);
      await writeFile(storedPath, content, 'utf-8');
      const meta: ImportedArtifact = {
        artifactId,
        sessionId,
        kind: 'text',
        purpose,
        size: Buffer.byteLength(content, 'utf-8'),
        sha256: sha256(content),
        createdAt: now().toISOString(),
        storedPath,
        preview: clipped(content),
      };
      artifacts.set(artifactId, meta);
      return {
        artifactId: meta.artifactId,
        size: meta.size,
        sha256: meta.sha256,
        preview: meta.preview,
        purpose: meta.purpose,
        createdAt: meta.createdAt,
      };
    },

    applyEdit: async ({ sessionId, artifactId, targetPath, mode, anchor, dryRun }) => {
      const { content } = await readArtifact(artifactId, sessionId);
      const fullTarget = resolveWorkspaceFile(rootPath, targetPath);
      const relTarget = normalizeRel(path.relative(rootPath, fullTarget));

      if (mode === 'apply_unified_diff') {
        const touched = diffTouchedFiles(content);
        if (touched.length === 0) throw new Error('Unified diff does not declare any target files.');
        if (touched.some((file) => file !== relTarget)) {
          throw new Error('Unified diff may only touch targetPath.');
        }
        const check = await runGitApply(rootPath, ['--check', '--include', relTarget], content);
        if (!check.ok) throw new Error(check.stderr || check.stdout || 'git apply --check failed.');
        if (dryRun === true) {
          return {
            ok: true,
            targetPath: fullTarget,
            changed: true,
            diffPreview: clipped(content, DIFF_PREVIEW_CHARS),
            undoHint: 'dryRun only; no files were changed.',
          };
        }
        const applied = await runGitApply(rootPath, ['--whitespace=nowarn', '--include', relTarget], content);
        if (!applied.ok) throw new Error(applied.stderr || applied.stdout || 'git apply failed.');
        return {
          ok: true,
          targetPath: fullTarget,
          changed: true,
          diffPreview: clipped(content, DIFF_PREVIEW_CHARS),
          undoHint: `Review with git diff -- ${relTarget}; revert with git checkout -- ${relTarget}.`,
        };
      }

      if (!anchor) throw new Error(`anchor is required for ${mode}.`);
      const current = await readFile(fullTarget, 'utf-8');
      const matches = countMatches(current, anchor);
      if (matches !== 1) throw new Error(`anchor must match exactly once; found ${matches}.`);

      const next =
        mode === 'replace_anchor'
          ? current.replace(anchor, content)
          : mode === 'insert_before'
            ? current.replace(anchor, `${content}${anchor}`)
            : current.replace(anchor, `${anchor}${content}`);
      const changed = next !== current;
      const diffPreview = renderDiffPreview(relTarget, current, next);
      if (dryRun === true || !changed) {
        return {
          ok: true,
          targetPath: fullTarget,
          changed,
          diffPreview,
          undoHint: dryRun === true ? 'dryRun only; no files were changed.' : 'No content change was needed.',
        };
      }

      const write = await writeTextFile(fullTarget, next);
      if (!write.ok) throw new Error(typeof write.message === 'string' ? write.message : 'MTUI write failed.');
      const backupId =
        typeof write.backupId === 'string'
          ? write.backupId
          : typeof write.backup_id === 'string'
            ? write.backup_id
            : undefined;
      return {
        ok: true,
        targetPath: fullTarget,
        changed: true,
        diffPreview,
        backupId,
        undoHint: backupId ? `MTUI backup ${backupId}` : 'Review with git diff; MTUI write path was used.',
      };
    },

    importMediaAsset: async ({ file, destPath, kind, overwrite }) => {
      const sourcePath = await resolveInputFile(file);
      const sourceExt = path.extname(sourcePath).toLowerCase();
      const dest = resolveAssetDest(rootPath, destPath);
      const destExt = path.extname(dest.fullPath).toLowerCase();
      const allowed = kind === 'image' ? IMAGE_EXTENSIONS : VIDEO_EXTENSIONS;
      if (!allowed.has(sourceExt)) throw new Error(`Unsupported ${kind} source extension: ${sourceExt || '(none)'}`);
      if (!allowed.has(destExt)) throw new Error(`Unsupported ${kind} destination extension: ${destExt || '(none)'}`);
      const sourceStat = await stat(sourcePath);
      const limit = kind === 'image' ? DEFAULT_IMAGE_MAX_BYTES : DEFAULT_VIDEO_MAX_BYTES;
      if (sourceStat.size > limit) throw new Error(`${kind} asset is ${sourceStat.size} bytes; limit is ${limit}.`);

      if (overwrite !== true) {
        try {
          await stat(dest.fullPath);
          throw new Error('destPath already exists. Pass overwrite:true to replace it.');
        } catch (error) {
          if (error instanceof Error && !('code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT')) {
            throw error;
          }
        }
      }
      await mkdir(path.dirname(dest.fullPath), { recursive: true });
      await copyFile(sourcePath, dest.fullPath);
      const copied = await readFile(dest.fullPath);
      const durationSeconds = kind === 'video' ? await probeVideoDuration(dest.fullPath) : undefined;
      return {
        ok: true,
        destPath: dest.fullPath,
        size: copied.length,
        sha256: sha256(copied),
        mime: mimeFor(destExt, kind),
        durationSeconds,
        warning:
          kind === 'video' && durationSeconds !== undefined && durationSeconds > 60
            ? `Video duration is ${Math.round(durationSeconds)}s; short product demos should usually stay near 30s.`
            : undefined,
      };
    },

    list: (sessionId) =>
      Array.from(artifacts.values())
        .filter((artifact) => sessionId === undefined || artifact.sessionId === sessionId)
        .map(({ artifactId, kind, purpose, size, sha256: hash, createdAt }) => ({
          artifactId,
          kind,
          purpose,
          size,
          sha256: hash,
          createdAt,
        })),

    delete: async (sessionId, artifactId) => {
      const meta = artifacts.get(artifactId);
      if (!meta) return false;
      if (sessionId !== undefined && meta.sessionId !== sessionId) return false;
      artifacts.delete(artifactId);
      await rm(meta.storedPath, { force: true });
      return true;
    },
  };
};
