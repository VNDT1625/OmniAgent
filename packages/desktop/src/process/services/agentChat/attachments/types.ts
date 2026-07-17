/**
 * Transport-neutral attachment and artifact contracts for agent messages.
 *
 * Source references are intentionally locator-only: credentials, bearer tokens,
 * inline binary payloads, and secret values do not belong in this envelope.
 */

export type AttachmentKind = 'text' | 'file' | 'image' | 'audio' | 'video';

export type LocalArtifactSource = {
  type: 'local-file';
  /** Absolute main-process path. It must be validated against an allowlisted root before use. */
  path: string;
};

export type OpaqueArtifactSource = {
  type: 'opaque';
  /** Connector or storage namespace, never an account credential. */
  provider: string;
  /** Non-secret lookup identifier. It must not be a URL, path, or bearer token. */
  ref: string;
};

export type ArtifactSourceRef = LocalArtifactSource | OpaqueArtifactSource;

export type AttachmentArtifact = {
  id: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  sizeBytes: number;
  /** Lowercase SHA-256 of the referenced content. */
  sha256: string;
  source: ArtifactSourceRef;
  createdAt: number;
};

export type AttachmentMessageBlock =
  | { type: 'text'; text: string }
  | { type: 'artifact'; artifact: AttachmentArtifact };

export type AttachmentMessageEnvelope = {
  version: 1;
  id: string;
  createdAt: number;
  blocks: AttachmentMessageBlock[];
};

export type ArtifactStorePutInput = Omit<AttachmentArtifact, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: number;
};

/**
 * Storage boundary for attachment bytes and locators. Implementations may use a
 * session directory, object storage, or a connector. Only the main process may
 * resolve a local path; renderer/model diagnostics must use redacted metadata.
 */
export type AttachmentArtifactStore = {
  put(input: ArtifactStorePutInput): Promise<AttachmentArtifact>;
  get(id: string): Promise<AttachmentArtifact | undefined>;
  remove(id: string): Promise<boolean>;
};

export type ArtifactBytePutInput = {
  id?: string;
  kind: AttachmentKind;
  name: string;
  mimeType: string;
  bytes: Uint8Array;
  expectedSha256?: string;
  createdAt?: number;
  expiresAt?: number;
  ownerId?: string;
};

export type ArtifactIntegrityResult =
  | { ok: true; artifact: AttachmentArtifact }
  | { ok: false; reason: 'missing' | 'invalid-metadata' | 'size-mismatch' | 'hash-mismatch' | 'expired' };

export type ArtifactCleanupResult = {
  removedArtifacts: number;
  removedBlobs: number;
  removedTemporaryFiles: number;
  invalidRecords: number;
};

export type PersistentAttachmentArtifactStore = AttachmentArtifactStore & {
  putBytes(input: ArtifactBytePutInput): Promise<AttachmentArtifact>;
  readBytes(id: string): Promise<Uint8Array>;
  verify(id: string): Promise<ArtifactIntegrityResult>;
  retain(id: string, ownerId: string): Promise<void>;
  releaseOwner(ownerId: string, deleteUnreferenced?: boolean): Promise<number>;
  cleanup(now?: number): Promise<ArtifactCleanupResult>;
};

export type RedactedAttachmentArtifact = Omit<AttachmentArtifact, 'source'> & {
  source: { type: 'local-file' } | { type: 'opaque'; provider: string };
};
