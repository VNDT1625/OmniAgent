import { access, readFile } from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import {
  planAttachmentDelivery,
  resolveAttachmentDelivery,
  redactAttachmentArtifact,
  TOMNY_ANALYZE_IMAGE_TOOL,
  validateAttachmentEnvelope,
  type AttachmentArtifact,
  type AttachmentMessageEnvelope,
  type PersistentAttachmentArtifactStore,
} from '@process/services/agentChat/attachments';

import { buildAcpPromptBlocks, withCodexTurnInput } from '@process/experimentalCore/adapters/attachmentPayload';

const HASH = 'a'.repeat(64);

const image = (overrides: Partial<AttachmentArtifact> = {}): AttachmentArtifact => ({
  id: 'artifact_image_1',
  kind: 'image',
  name: 'screen.png',
  mimeType: 'image/png',
  sizeBytes: 128,
  sha256: HASH,
  source: { type: 'local-file', path: 'C:\\workspace\\captures\\screen.png' },
  createdAt: 10,
  ...overrides,
});

const envelope = (artifact: AttachmentArtifact = image()): AttachmentMessageEnvelope => ({
  version: 1,
  id: 'message_1000',
  createdAt: 20,
  blocks: [
    { type: 'text', text: 'Inspect this UI.' },
    { type: 'artifact', artifact },
  ],
});

describe('attachment envelope validation', () => {
  it('accepts a bounded local image under an explicit allowlisted root', () => {
    const result = validateAttachmentEnvelope(envelope(), { allowedLocalRoots: ['C:\\workspace'] });

    expect(result.ok).toBe(true);
  });

  it('fails closed when a local path has no allowlisted root', () => {
    const result = validateAttachmentEnvelope(envelope());

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.code === 'path-not-allowed')).toBe(true);
  });

  it('rejects traversal even when the resolved target could be inside a root', () => {
    const value = envelope(image({ source: { type: 'local-file', path: 'C:\\workspace\\captures\\..\\screen.png' } }));

    const result = validateAttachmentEnvelope(value, { allowedLocalRoots: ['C:\\workspace'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.code === 'invalid-source')).toBe(true);
  });

  it('rejects incompatible MIME, malformed hash, and an oversized artifact', () => {
    const value = envelope(image({ mimeType: 'text/plain', sha256: 'bad', sizeBytes: 129 }));

    const result = validateAttachmentEnvelope(value, {
      allowedLocalRoots: ['C:\\workspace'],
      maxBytesByKind: { image: 128 },
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.map((issue) => issue.code)).toEqual(
        expect.arrayContaining(['invalid-mime', 'invalid-hash', 'limit-exceeded'])
      );
    }
  });

  it('rejects secret-shaped opaque sources such as URLs and path-like references', () => {
    const value = envelope(
      image({ source: { type: 'opaque', provider: 'connector', ref: 'https://host/file?token=secret' } })
    );

    const result = validateAttachmentEnvelope(value);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.code === 'invalid-source')).toBe(true);
  });

  it('accepts a safe opaque connector lookup without exposing credentials', () => {
    const value = envelope(image({ source: { type: 'opaque', provider: 'drive', ref: 'file_12345' } }));

    const result = validateAttachmentEnvelope(value);

    expect(result.ok).toBe(true);
  });

  it('rejects duplicate artifact ids in one message', () => {
    const value: AttachmentMessageEnvelope = {
      ...envelope(),
      blocks: [
        { type: 'artifact', artifact: image() },
        { type: 'artifact', artifact: image() },
      ],
    };

    const result = validateAttachmentEnvelope(value, { allowedLocalRoots: ['C:\\workspace'] });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.code === 'duplicate-artifact')).toBe(true);
  });

  it('rejects a secret-shaped opaque lookup even when its characters are otherwise safe', () => {
    const value = envelope(image({ source: { type: 'opaque', provider: 'connector', ref: 'sk_secret12345' } }));

    const result = validateAttachmentEnvelope(value);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.some((issue) => issue.code === 'invalid-source')).toBe(true);
  });

  it('redacts both local and opaque lookup values from diagnostics', () => {
    const local = redactAttachmentArtifact(image());
    const opaque = redactAttachmentArtifact(
      image({ source: { type: 'opaque', provider: 'drive', ref: 'file_12345' } })
    );

    expect(local.source).toEqual({ type: 'local-file' });
    expect(opaque.source).toEqual({ type: 'opaque', provider: 'drive' });
    expect(JSON.stringify([local, opaque])).not.toContain('file_12345');
  });
});

describe('attachment model routing', () => {
  it('routes an image directly only when the selected model supports native vision', () => {
    const plan = planAttachmentDelivery(envelope(), { nativeKinds: ['image'], callableTools: [] });

    expect(plan.artifacts[0]?.route).toBe('native');
    expect(plan.text).toBe('Inspect this UI.');
  });

  it('offers Tomny image analysis as an explicit agent tool without invoking OCR', () => {
    const plan = planAttachmentDelivery(envelope(), {
      nativeKinds: ['text'],
      callableTools: [TOMNY_ANALYZE_IMAGE_TOOL],
    });

    expect(plan.artifacts[0]).toMatchObject({
      route: 'agent-tool',
      toolName: TOMNY_ANALYZE_IMAGE_TOOL,
      requiresAgentInvocation: true,
    });
    expect(plan.text).toBe('Inspect this UI.');
  });

  it('marks an image unsupported when neither native vision nor the tool is available', () => {
    const plan = planAttachmentDelivery(envelope(), { nativeKinds: ['text'], callableTools: [] });

    expect(plan.artifacts[0]?.route).toBe('unsupported');
  });

  it('keeps future audio and video kinds transport-neutral until a capability is declared', () => {
    const audioArtifact = image({ kind: 'audio', name: 'clip.wav', mimeType: 'audio/wav' });
    const plan = planAttachmentDelivery(envelope(audioArtifact), { nativeKinds: [], callableTools: [] });

    expect(plan.artifacts[0]?.route).toBe('unsupported');
  });
});

describe('resolved attachment adapter delivery', () => {
  const storedImage = (): AttachmentArtifact =>
    image({
      sizeBytes: 3,
      source: { type: 'opaque', provider: 'tomny-artifact-store', ref: 'artifact_image_1' },
    });

  const fakeStore = (readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]))): PersistentAttachmentArtifactStore => ({
    put: vi.fn(),
    putBytes: vi.fn(),
    get: vi.fn(async () => storedImage()),
    remove: vi.fn(),
    readBytes,
    verify: vi.fn(async () => ({ ok: true as const, artifact: storedImage() })),
    retain: vi.fn(),
    releaseOwner: vi.fn(),
    cleanup: vi.fn(),
  });

  it('rehydrates bytes only for a native model route', async () => {
    const store = fakeStore();
    const resolved = await resolveAttachmentDelivery(
      envelope(storedImage()),
      { nativeKinds: ['image'], callableTools: [] },
      store
    );

    expect(resolved.native[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
    expect(resolved.native[0]?.artifact.source).toEqual({ type: 'opaque', provider: 'tomny-artifact-store' });
  });

  it('does not read image bytes when only advertising the explicit Tomny analysis tool', async () => {
    const readBytes = vi.fn(async () => new Uint8Array([1, 2, 3]));
    const resolved = await resolveAttachmentDelivery(
      envelope(storedImage()),
      { nativeKinds: [], callableTools: [TOMNY_ANALYZE_IMAGE_TOOL] },
      fakeStore(readBytes)
    );

    expect(readBytes).not.toHaveBeenCalled();
    expect(resolved.agentTools[0]).toMatchObject({ toolName: TOMNY_ANALYZE_IMAGE_TOOL, requiresAgentInvocation: true });
  });

  it('encodes native ACP image blocks while keeping tool-only images as metadata', async () => {
    const native = await resolveAttachmentDelivery(
      envelope(storedImage()),
      { nativeKinds: ['image'], callableTools: [] },
      fakeStore()
    );
    const blocks = buildAcpPromptBlocks('inspect', native);

    expect(blocks[1]).toMatchObject({ type: 'image', data: 'AQID', mimeType: 'image/png' });
  });

  it('removes temporary Codex image files immediately after the turn ends', async () => {
    const native = await resolveAttachmentDelivery(
      envelope(storedImage()),
      { nativeKinds: ['image'], callableTools: [] },
      fakeStore()
    );
    let materializedPath = '';
    await withCodexTurnInput('inspect', native, async (input) => {
      const imageInput = input.find((item) => item.type === 'localImage');
      if (imageInput?.type !== 'localImage') throw new Error('Expected a local Codex image input.');
      materializedPath = imageInput.path;
      await expect(readFile(materializedPath)).resolves.toEqual(Buffer.from([1, 2, 3]));
    });

    await expect(access(materializedPath)).rejects.toThrow();
  });
});
