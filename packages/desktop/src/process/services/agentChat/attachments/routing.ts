import type { AttachmentArtifact, AttachmentKind, AttachmentMessageEnvelope } from './types';

export const TOMNY_ANALYZE_IMAGE_TOOL = 'tomny_analyze_image';

export type AttachmentModelCapabilities = {
  /** Artifact kinds the selected transport/model accepts without a tool call. */
  nativeKinds: readonly AttachmentKind[];
  /** Tools visible to the agent for this surface and permission scope. */
  callableTools: readonly string[];
};

export type AttachmentDeliveryDecision =
  | { artifact: AttachmentArtifact; route: 'native' }
  | {
      artifact: AttachmentArtifact;
      route: 'agent-tool';
      toolName: typeof TOMNY_ANALYZE_IMAGE_TOOL;
      /** The core advertises the option but never invokes image analysis automatically. */
      requiresAgentInvocation: true;
    }
  | { artifact: AttachmentArtifact; route: 'unsupported'; reason: string };

export type AttachmentDeliveryPlan = {
  envelopeId: string;
  /** Text remains in original block order and is never replaced by implicit OCR. */
  text: string;
  artifacts: AttachmentDeliveryDecision[];
};

const decideArtifactRoute = (
  artifact: AttachmentArtifact,
  capabilities: AttachmentModelCapabilities
): AttachmentDeliveryDecision => {
  if (capabilities.nativeKinds.includes(artifact.kind)) return { artifact, route: 'native' };
  if (artifact.kind === 'image' && capabilities.callableTools.includes(TOMNY_ANALYZE_IMAGE_TOOL)) {
    return {
      artifact,
      route: 'agent-tool',
      toolName: TOMNY_ANALYZE_IMAGE_TOOL,
      requiresAgentInvocation: true,
    };
  }
  return {
    artifact,
    route: 'unsupported',
    reason:
      artifact.kind === 'image'
        ? 'Selected model has no native vision and no explicit Tomny image-analysis tool.'
        : `Selected model/transport does not accept ${artifact.kind} artifacts.`,
  };
};

/**
 * Build a deterministic delivery plan after validation. This function never
 * reads a file, performs OCR, or calls a tool; adapters and agents retain full
 * control over when an explicit tool is invoked.
 */
export const planAttachmentDelivery = (
  envelope: AttachmentMessageEnvelope,
  capabilities: AttachmentModelCapabilities
): AttachmentDeliveryPlan => ({
  envelopeId: envelope.id,
  text: envelope.blocks
    .filter((block): block is Extract<typeof block, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('\n'),
  artifacts: envelope.blocks
    .filter((block): block is Extract<typeof block, { type: 'artifact' }> => block.type === 'artifact')
    .map((block) => decideArtifactRoute(block.artifact, capabilities)),
});
