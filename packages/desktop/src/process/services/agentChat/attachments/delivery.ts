import { planAttachmentDelivery, type AttachmentModelCapabilities } from './routing';
import type {
  AttachmentArtifact,
  AttachmentMessageEnvelope,
  PersistentAttachmentArtifactStore,
  RedactedAttachmentArtifact,
} from './types';
import { redactAttachmentArtifact, validateAttachmentEnvelope } from './validation';

export type ResolvedNativeAttachment = {
  route: 'native';
  artifact: RedactedAttachmentArtifact;
  bytes: Uint8Array;
};

export type ResolvedAgentToolAttachment = {
  route: 'agent-tool';
  artifact: RedactedAttachmentArtifact;
  toolName: 'tomny_analyze_image';
  requiresAgentInvocation: true;
};

export type ResolvedAttachmentDelivery = {
  envelopeId: string;
  text: string;
  native: ResolvedNativeAttachment[];
  agentTools: ResolvedAgentToolAttachment[];
};

const sameArtifact = (left: AttachmentArtifact, right: AttachmentArtifact): boolean =>
  left.id === right.id &&
  left.kind === right.kind &&
  left.name === right.name &&
  left.mimeType === right.mimeType &&
  left.sizeBytes === right.sizeBytes &&
  left.sha256 === right.sha256 &&
  left.createdAt === right.createdAt &&
  left.source.type === 'opaque' &&
  right.source.type === 'opaque' &&
  left.source.provider === right.source.provider &&
  left.source.ref === right.source.ref;

/** Resolve only canonical, integrity-checked store references for a single adapter run. */
export const resolveAttachmentDelivery = async (
  envelope: AttachmentMessageEnvelope,
  capabilities: AttachmentModelCapabilities,
  store: PersistentAttachmentArtifactStore
): Promise<ResolvedAttachmentDelivery> => {
  const validation = validateAttachmentEnvelope(envelope);
  if ('issues' in validation) {
    throw new Error(`Attachment envelope is invalid: ${validation.issues[0]?.message ?? 'unknown error'}`);
  }
  const plan = planAttachmentDelivery(validation.value, capabilities);
  const unsupported = plan.artifacts.find((entry) => entry.route === 'unsupported');
  if (unsupported?.route === 'unsupported') throw new Error(unsupported.reason);

  const resolved = await Promise.all(
    plan.artifacts.map(async (decision): Promise<ResolvedNativeAttachment | ResolvedAgentToolAttachment> => {
      const canonical = await store.get(decision.artifact.id);
      if (!canonical || !sameArtifact(canonical, decision.artifact)) {
        throw new Error(`Attachment ${decision.artifact.id} does not match its canonical artifact record.`);
      }
      const integrity = await store.verify(canonical.id);
      if (integrity.ok === false) {
        throw new Error(`Attachment ${canonical.id} failed integrity verification: ${integrity.reason}.`);
      }
      if (decision.route === 'native') {
        return {
          route: 'native',
          artifact: redactAttachmentArtifact(canonical),
          bytes: await store.readBytes(canonical.id),
        };
      }
      if (decision.route === 'agent-tool') {
        return {
          route: 'agent-tool',
          artifact: redactAttachmentArtifact(canonical),
          toolName: decision.toolName,
          requiresAgentInvocation: true,
        };
      }
      throw new Error('Unsupported attachment delivery cannot be resolved.');
    })
  );
  return {
    envelopeId: plan.envelopeId,
    text: plan.text,
    native: resolved.filter((item): item is ResolvedNativeAttachment => item.route === 'native'),
    agentTools: resolved.filter((item): item is ResolvedAgentToolAttachment => item.route === 'agent-tool'),
  };
};
