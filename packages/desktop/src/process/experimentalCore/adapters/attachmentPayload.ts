import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ResolvedAttachmentDelivery, ResolvedNativeAttachment } from '@process/services/agentChat/attachments';

export type CodexTurnInput = { type: 'text'; text: string; text_elements: [] } | { type: 'localImage'; path: string };

export type AcpPromptBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string; uri?: string };

const extensionForMime = (mimeType: string): string => {
  const normalized = mimeType.toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  return '.png';
};

const toolNotice = (attachments?: ResolvedAttachmentDelivery): string => {
  if (!attachments?.agentTools.length) return '';
  return [
    '[Tomny attachments available through explicit agent tools]',
    ...attachments.agentTools.map(
      ({ artifact, toolName }) =>
        `- artifactId=${JSON.stringify(artifact.id)}, name=${JSON.stringify(artifact.name)}, mimeType=${JSON.stringify(artifact.mimeType)}; call ${toolName} only if inspection is needed.`
    ),
  ].join('\n');
};

export const promptWithAttachmentToolNotice = (prompt: string, attachments?: ResolvedAttachmentDelivery): string => {
  const notice = toolNotice(attachments);
  return notice ? `${prompt}\n\n${notice}` : prompt;
};

export const buildAcpPromptBlocks = (prompt: string, attachments?: ResolvedAttachmentDelivery): AcpPromptBlock[] => [
  { type: 'text', text: promptWithAttachmentToolNotice(prompt, attachments) },
  ...(attachments?.native ?? [])
    .filter((entry) => entry.artifact.kind === 'image')
    .map((entry) => ({
      type: 'image' as const,
      data: Buffer.from(entry.bytes).toString('base64'),
      mimeType: entry.artifact.mimeType,
      uri: `tomny-artifact://${entry.artifact.id}`,
    })),
];

const writeCodexImage = async (directory: string, entry: ResolvedNativeAttachment, index: number): Promise<string> => {
  if (entry.artifact.kind !== 'image')
    throw new Error('Codex native attachment transport currently accepts images only.');
  const filePath = path.join(directory, `image-${index}${extensionForMime(entry.artifact.mimeType)}`);
  await writeFile(filePath, entry.bytes, { flag: 'wx', mode: 0o600 });
  return filePath;
};

/** Keep materialized image paths alive only for the duration of a Codex turn. */
export const withCodexTurnInput = async <T>(
  prompt: string,
  attachments: ResolvedAttachmentDelivery | undefined,
  run: (input: CodexTurnInput[]) => Promise<T>
): Promise<T> => {
  const native = attachments?.native ?? [];
  if (native.length === 0) {
    return run([{ type: 'text', text: promptWithAttachmentToolNotice(prompt, attachments), text_elements: [] }]);
  }
  const directory = await mkdtemp(path.join(tmpdir(), 'tomny-core-attachments-'));
  try {
    const images = await Promise.all(native.map((entry, index) => writeCodexImage(directory, entry, index)));
    return await run([
      { type: 'text', text: promptWithAttachmentToolNotice(prompt, attachments), text_elements: [] },
      ...images.map((imagePath) => ({ type: 'localImage' as const, path: imagePath })),
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
};
