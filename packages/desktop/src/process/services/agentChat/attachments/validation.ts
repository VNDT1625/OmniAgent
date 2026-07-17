import * as path from 'node:path';
import type {
  AttachmentArtifact,
  AttachmentKind,
  AttachmentMessageEnvelope,
  RedactedAttachmentArtifact,
} from './types';

export type AttachmentValidationIssue = {
  code:
    | 'invalid-envelope'
    | 'invalid-id'
    | 'invalid-name'
    | 'invalid-mime'
    | 'invalid-size'
    | 'invalid-hash'
    | 'invalid-source'
    | 'path-not-allowed'
    | 'limit-exceeded'
    | 'duplicate-artifact';
  path: string;
  message: string;
};

export type AttachmentValidationPolicy = {
  /** Local files are denied when no roots are supplied. */
  allowedLocalRoots?: readonly string[];
  maxArtifacts?: number;
  maxBlocks?: number;
  maxTextChars?: number;
  maxTotalBytes?: number;
  maxBytesByKind?: Partial<Record<AttachmentKind, number>>;
};

export type AttachmentValidationResult =
  | { ok: true; value: AttachmentMessageEnvelope }
  | { ok: false; issues: AttachmentValidationIssue[] };

const KINDS = new Set<AttachmentKind>(['text', 'file', 'image', 'audio', 'video']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{3,127}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const MIME_RE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const SAFE_OPAQUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;

const SECRET_SHAPED_REF_RE = /^(?:sk[-_]|gh[pousr]_|xox[baprs]-|bearer[._-]|eyJ[A-Za-z0-9_-]{8,}\\.)/i;
const DEFAULT_MAX_BY_KIND: Record<AttachmentKind, number> = {
  text: 5 * 1024 * 1024,
  file: 50 * 1024 * 1024,
  image: 25 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  video: 500 * 1024 * 1024,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isPortableAbsolute = (value: string): boolean => path.isAbsolute(value) || path.win32.isAbsolute(value);
const hasTraversal = (value: string): boolean => value.replace(/\\/g, '/').split('/').includes('..');
const pathApi = (value: string): typeof path.posix | typeof path.win32 =>
  path.win32.isAbsolute(value) ? path.win32 : path.posix;

const isWithinRoot = (candidate: string, root: string): boolean => {
  if (!isPortableAbsolute(root)) return false;
  const api = pathApi(candidate);
  if (api !== pathApi(root)) return false;
  const resolvedCandidate = api.resolve(candidate);
  const resolvedRoot = api.resolve(root);
  const relative = api.relative(resolvedRoot, resolvedCandidate);
  const outside = relative === '..' || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative);
  return !outside;
};

const mimeMatchesKind = (kind: AttachmentKind, mimeType: string): boolean => {
  if (kind === 'file') return MIME_RE.test(mimeType);
  if (kind === 'text') return mimeType.startsWith('text/') || /\/(?:json|xml)$/i.test(mimeType);
  return mimeType.startsWith(`${kind}/`);
};

const validName = (name: string): boolean => {
  if (name.length === 0 || name.length > 255 || name === '.' || name === '..') return false;
  return (
    !name.includes('/') &&
    !name.includes('\\') &&
    ![...name].some((char) => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127)
  );
};

const push = (
  issues: AttachmentValidationIssue[],
  code: AttachmentValidationIssue['code'],
  issuePath: string,
  message: string
): void => {
  issues.push({ code, path: issuePath, message });
};

const validateSource = (
  source: unknown,
  issuePath: string,
  roots: readonly string[],
  issues: AttachmentValidationIssue[]
): void => {
  if (!isRecord(source) || (source.type !== 'local-file' && source.type !== 'opaque')) {
    push(issues, 'invalid-source', issuePath, 'Source must be a local-file or opaque locator.');
    return;
  }
  if (source.type === 'local-file') {
    if (typeof source.path !== 'string' || source.path.includes('\0') || !isPortableAbsolute(source.path)) {
      push(issues, 'invalid-source', `${issuePath}.path`, 'Local source must be an absolute path without NUL bytes.');
      return;
    }
    if (hasTraversal(source.path)) {
      push(issues, 'invalid-source', `${issuePath}.path`, 'Local source must not contain parent traversal segments.');
      return;
    }
    if (roots.length === 0 || !roots.some((root) => isWithinRoot(source.path as string, root))) {
      push(issues, 'path-not-allowed', `${issuePath}.path`, 'Local source is outside the allowlisted roots.');
    }
    return;
  }
  if (
    typeof source.provider !== 'string' ||
    typeof source.ref !== 'string' ||
    !SAFE_OPAQUE_RE.test(source.provider) ||
    !SAFE_OPAQUE_RE.test(source.ref) ||
    SECRET_SHAPED_REF_RE.test(source.ref) ||
    source.ref.includes('://')
  ) {
    push(
      issues,
      'invalid-source',
      issuePath,
      'Opaque source must contain only a provider and a non-secret lookup identifier.'
    );
  }
};

const validateArtifact = (
  artifact: unknown,
  issuePath: string,
  policy: Required<AttachmentValidationPolicy>,
  issues: AttachmentValidationIssue[]
): number => {
  if (!isRecord(artifact)) {
    push(issues, 'invalid-envelope', issuePath, 'Artifact block must contain an object.');
    return 0;
  }
  if (typeof artifact.id !== 'string' || !ID_RE.test(artifact.id)) {
    push(issues, 'invalid-id', `${issuePath}.id`, 'Artifact id must be a safe opaque identifier.');
  }
  if (typeof artifact.kind !== 'string' || !KINDS.has(artifact.kind as AttachmentKind)) {
    push(issues, 'invalid-envelope', `${issuePath}.kind`, 'Unsupported artifact kind.');
  }
  if (typeof artifact.name !== 'string' || !validName(artifact.name)) {
    push(issues, 'invalid-name', `${issuePath}.name`, 'Name must be a basename without separators or control bytes.');
  }
  if (
    typeof artifact.mimeType !== 'string' ||
    !MIME_RE.test(artifact.mimeType) ||
    (KINDS.has(artifact.kind as AttachmentKind) && !mimeMatchesKind(artifact.kind as AttachmentKind, artifact.mimeType))
  ) {
    push(issues, 'invalid-mime', `${issuePath}.mimeType`, 'MIME type is invalid or incompatible with artifact kind.');
  }
  const size = artifact.sizeBytes;
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    push(issues, 'invalid-size', `${issuePath}.sizeBytes`, 'Size must be a non-negative safe integer.');
  } else if (
    KINDS.has(artifact.kind as AttachmentKind) &&
    (size as number) > policy.maxBytesByKind[artifact.kind as AttachmentKind]
  ) {
    push(issues, 'limit-exceeded', `${issuePath}.sizeBytes`, 'Artifact exceeds the configured size limit.');
  }
  if (typeof artifact.sha256 !== 'string' || !SHA256_RE.test(artifact.sha256)) {
    push(issues, 'invalid-hash', `${issuePath}.sha256`, 'SHA-256 must be 64 lowercase hexadecimal characters.');
  }
  if (!Number.isSafeInteger(artifact.createdAt) || (artifact.createdAt as number) < 0) {
    push(issues, 'invalid-envelope', `${issuePath}.createdAt`, 'createdAt must be a non-negative integer.');
  }
  validateSource(artifact.source, `${issuePath}.source`, policy.allowedLocalRoots, issues);
  return Number.isSafeInteger(size) && (size as number) >= 0 ? (size as number) : 0;
};

/** Validate untrusted renderer, connector, or persisted attachment data before routing it. */
export const validateAttachmentEnvelope = (
  input: unknown,
  options: AttachmentValidationPolicy = {}
): AttachmentValidationResult => {
  const policy: Required<AttachmentValidationPolicy> = {
    allowedLocalRoots: options.allowedLocalRoots ?? [],
    maxArtifacts: options.maxArtifacts ?? 32,
    maxBlocks: options.maxBlocks ?? 64,
    maxTextChars: options.maxTextChars ?? 1_000_000,
    maxTotalBytes: options.maxTotalBytes ?? 500 * 1024 * 1024,
    maxBytesByKind: { ...DEFAULT_MAX_BY_KIND, ...options.maxBytesByKind },
  };
  const issues: AttachmentValidationIssue[] = [];
  if (!isRecord(input) || input.version !== 1 || !Array.isArray(input.blocks)) {
    return {
      ok: false,
      issues: [{ code: 'invalid-envelope', path: '$', message: 'Expected a version 1 attachment envelope.' }],
    };
  }
  if (typeof input.id !== 'string' || !ID_RE.test(input.id)) {
    push(issues, 'invalid-id', '$.id', 'Envelope id must be a safe opaque identifier.');
  }
  if (!Number.isSafeInteger(input.createdAt) || (input.createdAt as number) < 0) {
    push(issues, 'invalid-envelope', '$.createdAt', 'createdAt must be a non-negative integer.');
  }
  if (input.blocks.length === 0 || input.blocks.length > policy.maxBlocks) {
    push(issues, 'limit-exceeded', '$.blocks', 'Envelope must contain a bounded, non-empty block list.');
  }

  let artifactCount = 0;
  let totalBytes = 0;
  const ids = new Set<string>();
  input.blocks.forEach((block, index) => {
    const blockPath = `$.blocks[${index}]`;
    if (!isRecord(block)) {
      push(issues, 'invalid-envelope', blockPath, 'Message block must be an object.');
      return;
    }
    if (block.type === 'text') {
      if (typeof block.text !== 'string' || block.text.length > policy.maxTextChars) {
        push(issues, 'limit-exceeded', `${blockPath}.text`, 'Text block is invalid or exceeds the configured limit.');
      }
      return;
    }
    if (block.type !== 'artifact') {
      push(issues, 'invalid-envelope', `${blockPath}.type`, 'Unknown message block type.');
      return;
    }
    artifactCount += 1;
    totalBytes += validateArtifact(block.artifact, `${blockPath}.artifact`, policy, issues);
    if (isRecord(block.artifact) && typeof block.artifact.id === 'string') {
      if (ids.has(block.artifact.id)) {
        push(issues, 'duplicate-artifact', `${blockPath}.artifact.id`, 'Artifact ids must be unique per envelope.');
      }
      ids.add(block.artifact.id);
    }
  });
  if (artifactCount > policy.maxArtifacts) {
    push(issues, 'limit-exceeded', '$.blocks', 'Envelope contains too many artifacts.');
  }
  if (totalBytes > policy.maxTotalBytes) {
    push(issues, 'limit-exceeded', '$.blocks', 'Envelope exceeds the total attachment byte limit.');
  }
  return issues.length === 0 ? { ok: true, value: input as AttachmentMessageEnvelope } : { ok: false, issues };
};

/** Remove source locators before logging, telemetry, or model-visible diagnostics. */
export const redactAttachmentArtifact = (artifact: AttachmentArtifact): RedactedAttachmentArtifact => ({
  ...artifact,
  source:
    artifact.source.type === 'local-file'
      ? { type: 'local-file' }
      : { type: 'opaque', provider: artifact.source.provider },
});
