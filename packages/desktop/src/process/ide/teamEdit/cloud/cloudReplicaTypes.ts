/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Persisted and renderer-facing types for a local cloud workspace replica. */

export type ReplicaFileBase = {
  hash: string;
  encoding: 'utf8' | 'base64';
};

export type ReplicaConflict = {
  id: string;
  relPath: string;
  baseHash: string | null;
  localHash: string | null;
  remoteHash: string | null;
  localEncoding: 'utf8' | 'base64' | null;
  remoteEncoding: 'utf8' | 'base64' | null;
  baseContent: string;
  localContent: string;
  remoteContent: string;
  createdAt: number;
};

export type ReplicaPersistedState = {
  schemaVersion: 1;
  workspaceId: string;
  rootPath: string;
  lastSyncedSeq: number;
  files: Record<string, ReplicaFileBase>;
  conflicts: ReplicaConflict[];
  updatedAt: number;
};

export type ReplicaSyncStatus = {
  enabled: boolean;
  rootPath?: string;
  state: 'idle' | 'scanning' | 'syncing' | 'offline' | 'conflict' | 'error';
  lastSyncedSeq: number;
  pendingFiles: number;
  conflicts: ReplicaConflict[];
  lastSyncAt?: number;
  error?: string;
};

export type ReplicaConflictResolution = 'local' | 'remote' | 'merged';
