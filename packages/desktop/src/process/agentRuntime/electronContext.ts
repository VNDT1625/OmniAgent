import { app, safeStorage } from 'electron';
import * as path from 'node:path';
import { createCoreContextComposer } from './contextComposer';
import { createContextStore, type ContextStore } from './contextStore';
import { createFileSecretRepository, createSecretVault, type SecretVault, type SecretVaultCodec } from './secretVault';
import type { AgentContext, CoreContextComposer, PersonalContext } from './contextTypes';

const safeStorageCodec: SecretVaultCodec = {
  available: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt: (plainText) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secret encryption is unavailable.');
    return safeStorage.encryptString(plainText).toString('base64');
  },
  decrypt: (cipherText) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secret encryption is unavailable.');
    return safeStorage.decryptString(Buffer.from(cipherText, 'base64'));
  },
};

const defaultAgent = (): AgentContext => ({
  id: 'tomny',
  name: 'Tomny',
  role: 'General agentic assistant',
  identity: 'A surface-aware agent that plans, uses trusted tools, and reports evidence honestly.',
  traits: ['proactive', 'precise', 'transparent'],
  capabilities: ['direct CLI transport', 'surface tools', 'Team and Company orchestration'],
  instructions: [
    'Use the active surface capabilities instead of assuming unavailable tools.',
    'Make minor reversible decisions within the user decision policy; ask before sensitive or irreversible actions.',
  ],
  updatedAt: Date.now(),
});

const defaultPersonal = (): PersonalContext => ({
  id: 'default',
  facts: [],
  preferences: [],
  communication: { vocabulary: [], writingGuidance: [] },
  decisionPolicy: { autonomy: 'minor-only', mayDecideCategories: [], alwaysAskCategories: ['secrets', 'payments'] },
  habits: [],
  secretReferences: [],
  updatedAt: Date.now(),
});

const ensureDefaultContexts = async (store: ContextStore): Promise<void> => {
  const [agent, personal] = await Promise.all([store.getAgent('tomny'), store.getPersonal('default')]);
  await Promise.all([
    agent ? Promise.resolve() : store.upsertAgent(defaultAgent()),
    personal ? Promise.resolve() : store.upsertPersonal(defaultPersonal()),
  ]);
};

export type ElectronContextServices = {
  composer: CoreContextComposer;
  vault: SecretVault;
  store: ContextStore;
  ready: Promise<void>;
};

/** Main-process wiring. Renderer and model transports never receive the vault instance. */
export const createElectronContextServices = (): ElectronContextServices => {
  const directory = path.join(app.getPath('userData'), 'tomny-core', 'context');
  const store = createContextStore(path.join(directory, 'profiles.json'));
  const repository = createFileSecretRepository(path.join(directory, 'secrets.json'));
  const ready = ensureDefaultContexts(store);
  const baseComposer = createCoreContextComposer(store);
  const composer: CoreContextComposer = {
    async composePrompt(input) {
      await ready;
      return baseComposer.composePrompt(input);
    },
  };
  return { composer, vault: createSecretVault(repository, safeStorageCodec), store, ready };
};
