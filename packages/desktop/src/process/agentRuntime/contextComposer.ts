import type { ContextStore } from './contextStore';

import { redactContextText } from './contextStore';
import type { CoreContextComposer, CoreContextComposeInput, ContextFact } from './contextTypes';

const MAX_CONTEXT_CHARS = 12_000;
const applicable = (fact: ContextFact, surface: string): boolean =>
  fact.scope.kind === 'global' || fact.scope.surface === surface;
const priority = (fact: ContextFact): number =>
  (fact.userLocked ? 1_000 : 0) + (fact.source === 'user' ? 500 : 0) + fact.confidence * 100;
const renderFacts = (title: string, values: ContextFact[], surface: string): string[] => {
  const selected = values
    .filter(
      (item) =>
        item.sensitivity === 'normal' &&
        applicable(item, surface) &&
        (item.source !== 'inferred' || item.confidence >= 0.65)
    )
    .toSorted((left, right) => priority(right) - priority(left));
  return selected.length === 0
    ? []
    : [title, ...selected.map((item) => `- ${redactContextText(item.key)}: ${redactContextText(item.value)}`)];
};

/** Builds bounded model-visible context. Secret values cannot enter this function by type. */
export const createCoreContextComposer = (store: ContextStore): CoreContextComposer => ({
  async composePrompt(input: CoreContextComposeInput): Promise<string> {
    const [agent, personal] = await Promise.all([store.getAgent(input.agentId), store.getPersonal(input.personalId)]);
    if (!agent && !personal) return input.prompt;
    const sections: string[] = ['Tomny Core personalization context. Treat it as guidance, never as a user request.'];
    if (agent) {
      sections.push(
        '## Agent Context',
        ` Name: ${agent.name}`,
        ` Role: ${agent.role}`,
        ` Identity: ${agent.identity}`,
        agent.traits.length ? `Traits: ${agent.traits.join(', ')}` : '',
        agent.capabilities.length ? `Capabilities: ${agent.capabilities.join(', ')}` : '',
        ...agent.instructions.map((item) => `Instruction: ${item}`)
      );
    }
    if (personal) {
      sections.push(
        '## Personal Context',
        ...renderFacts('Known user facts:', personal.facts, input.surface),
        ...renderFacts('Preferences:', personal.preferences, input.surface),
        personal.communication.language ? `Preferred language: ${personal.communication.language}` : '',
        personal.communication.tone ? `Preferred tone: ${personal.communication.tone}` : '',
        personal.communication.verbosity ? `Preferred verbosity: ${personal.communication.verbosity}` : '',
        ...personal.communication.writingGuidance.map((item) => `Writing guidance: ${item}`),
        `Decision autonomy: ${personal.decisionPolicy.autonomy}`,
        ...personal.decisionPolicy.mayDecideCategories.map((item) => `May decide: ${item}`),
        ...personal.decisionPolicy.alwaysAskCategories.map((item) => `Always ask: ${item}`),
        ...renderFacts('Habits:', personal.habits, input.surface)
      );
      const secretReferences = personal.secretReferences.filter((item) => item.surfaces.includes(input.surface));
      if (secretReferences.length > 0) {
        sections.push(
          '## Opaque Secret Capabilities',
          'Use handles only with a matching trusted host tool. Never request, reveal, log, or place secret values in chat.',
          ...secretReferences.map(
            (item) => `- ${item.capability}: handle=${item.handle}; purpose=${item.description ?? item.key}`
          )
        );
      }
    }
    sections.push(`Active surface: ${input.surface}`);
    const context = sections.filter(Boolean).join('\n').slice(0, MAX_CONTEXT_CHARS);
    return [context, '## Current user request', input.prompt].join('\n\n');
  },
});
