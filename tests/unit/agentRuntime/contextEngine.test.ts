import { describe, expect, it } from 'vitest';

import { createCoreContextComposer } from '@/process/agentRuntime/contextComposer';
import { createContextStore, mergeLearnedFact, type ContextStore } from '@/process/agentRuntime/contextStore';
import {
  createSecretVault,
  type SecretVaultCodec,
  type SecretVaultRepository,
  type StoredSecret,
} from '@/process/agentRuntime/secretVault';
import type { AgentContext, ContextFact, PersonalContext, SecretDescriptor } from '@/process/agentRuntime/contextTypes';

const NOW = 1_720_000_000_000;
const RAW_PASSWORD = 'p@ssword-that-must-never-leak';

const fact = (overrides: Partial<ContextFact> = {}): ContextFact => ({
  key: 'displayName',
  value: 'Thuan',
  confidence: 1,
  source: 'user',
  learnedAt: NOW,
  scope: { kind: 'global' },
  sensitivity: 'normal',
  userLocked: false,
  ...overrides,
});

const agent: AgentContext = {
  id: 'tomny',
  name: 'Tomny',
  role: 'assistant',
  identity: 'A surface-aware agent',
  traits: ['careful'],
  capabilities: ['coding'],
  instructions: ['Respect user intent.'],
  updatedAt: NOW,
};

const personal = (overrides: Partial<PersonalContext> = {}): PersonalContext => ({
  id: 'default',
  facts: [],
  preferences: [],
  communication: { vocabulary: [], writingGuidance: [] },
  decisionPolicy: { autonomy: 'minor-only', mayDecideCategories: [], alwaysAskCategories: ['secrets'] },
  habits: [],
  secretReferences: [],
  updatedAt: NOW,
  ...overrides,
});

const contextStore = (person: PersonalContext): ContextStore => ({
  getAgent: async () => structuredClone(agent),
  getPersonal: async () => structuredClone(person),
  upsertAgent: async () => undefined,
  upsertPersonal: async () => undefined,
  learnPersonalFact: async () => false,
});

const createMemoryRepository = (): SecretVaultRepository & { records: StoredSecret[] } => {
  const repository: SecretVaultRepository & { records: StoredSecret[] } = {
    records: [],
    async list() {
      return structuredClone(repository.records);
    },
    async save(values) {
      repository.records = structuredClone(values);
    },
  };
  return repository;
};

const availableCodec: SecretVaultCodec = {
  available: () => true,
  encrypt: (plainText) => Buffer.from(plainText, 'utf8').toString('base64'),
  decrypt: (cipherText) => Buffer.from(cipherText, 'base64').toString('utf8'),
};

const descriptorInput: Omit<SecretDescriptor, 'handle' | 'createdAt' | 'updatedAt'> = {
  label: 'Facebook login',
  kind: 'credential',
  fields: ['username', 'password'],
  binding: {
    surfaces: ['browser'],
    purposes: ['facebook-login'],
    targets: ['facebook.com'],
  },
};

describe('Context prompt security boundaries', () => {
  it('keeps private facts and their raw values out of model-visible context', async () => {
    const composer = createCoreContextComposer(
      contextStore(
        personal({
          facts: [fact(), fact({ key: 'accountPassword', value: RAW_PASSWORD, sensitivity: 'private' })],
        })
      )
    );

    const prompt = await composer.composePrompt({
      agentId: 'tomny',
      personalId: 'default',
      surface: 'ide',
      prompt: 'Open the project.',
    });

    expect(prompt).toContain('- displayName: Thuan');
    expect(prompt).not.toContain('accountPassword');
    expect(prompt).not.toContain(RAW_PASSWORD);
  });

  it('includes normal facts only on their declared surface', async () => {
    const composer = createCoreContextComposer(
      contextStore(
        personal({
          preferences: [fact({ key: 'editor', value: 'VS Code', scope: { kind: 'surface', surface: 'ide' } })],
        })
      )
    );

    const browserPrompt = await composer.composePrompt({
      agentId: 'tomny',
      personalId: 'default',
      surface: 'browser',
      prompt: 'Continue.',
    });

    expect(browserPrompt).not.toContain('VS Code');
  });

  it('redacts credential-shaped values even when incorrectly marked as normal', async () => {
    const composer = createCoreContextComposer(
      contextStore(personal({ facts: [fact({ value: 'password=do-not-leak' })] }))
    );
    const prompt = await composer.composePrompt({
      agentId: 'tomny',
      personalId: 'default',
      surface: 'ide',
      prompt: 'Continue.',
    });

    expect(prompt).not.toContain('do-not-leak');
    expect(prompt).toContain('[REDACTED]');
  });
  it('advertises only opaque secret handles bound to the active surface', async () => {
    const composer = createCoreContextComposer(
      contextStore(
        personal({
          secretReferences: [
            {
              key: 'facebook',
              handle: 'secret://facebook',
              capability: 'browser.type-secret',
              surfaces: ['browser'],
              purposes: ['facebook-login'],
              description: 'Sign in to Facebook',
            },
          ],
        })
      )
    );

    const browserPrompt = await composer.composePrompt({
      agentId: 'tomny',
      personalId: 'default',
      surface: 'browser',
      prompt: 'Sign me in.',
    });
    const idePrompt = await composer.composePrompt({
      agentId: 'tomny',
      personalId: 'default',
      surface: 'ide',
      prompt: 'Inspect code.',
    });

    expect(browserPrompt).toContain('handle=secret://facebook');
    expect(idePrompt).not.toContain('secret://facebook');
    expect(browserPrompt).not.toContain(RAW_PASSWORD);
  });
});

describe('Context learning conflict policy', () => {
  it('refuses to overwrite a user-locked fact with an inference', () => {
    const locked = fact({ value: 'Thu?n', userLocked: true });
    const inferred = fact({ value: 'Wrong name', source: 'inferred', confidence: 1, userLocked: false });

    const result = mergeLearnedFact([locked], inferred);

    expect(result.accepted).toBe(false);
    expect(result.values).toEqual([locked]);
  });

  it('rejects learning for an unknown personal profile', async () => {
    const missing = Object.assign(new Error('missing'), { code: 'ENOENT' });
    const fsImpl = {
      readFile: async () => Promise.reject<string>(missing),
      writeFile: async () => undefined,
      rename: async () => undefined,
      mkdir: async () => undefined,
    };
    const store = createContextStore('C:/profiles/context.json', fsImpl);

    await expect(store.learnPersonalFact('unknown', 'facts', fact())).rejects.toThrow(
      'Personal context not found: unknown'
    );
  });
});

describe('Secret vault capability policy', () => {
  it('fails closed when OS encryption is unavailable', async () => {
    const repository = createMemoryRepository();
    const codec: SecretVaultCodec = {
      available: () => false,
      encrypt: () => {
        throw new Error('must not encrypt');
      },
      decrypt: () => {
        throw new Error('must not decrypt');
      },
    };
    const vault = createSecretVault(repository, codec);

    await expect(vault.put(descriptorInput, { username: 'thuan', password: RAW_PASSWORD })).rejects.toThrow(
      'OS secret encryption is unavailable'
    );
    expect(repository.records).toHaveLength(0);
  });

  it.each([
    [
      'surface',
      { surface: 'ide', purpose: 'facebook-login', target: 'facebook.com', fields: ['password'] },
      'not allowed on this surface',
    ],
    [
      'purpose',
      { surface: 'browser', purpose: 'export-password', target: 'facebook.com', fields: ['password'] },
      'not allowed for this purpose',
    ],
    [
      'target',
      { surface: 'browser', purpose: 'facebook-login', target: 'evil.example', fields: ['password'] },
      'not allowed for this target',
    ],
    [
      'field',
      { surface: 'browser', purpose: 'facebook-login', target: 'facebook.com', fields: ['cookie'] },
      'field is not allowed',
    ],
  ])('refuses resolution when the requested %s is outside the allowlist', async (_boundary, request, message) => {
    const vault = createSecretVault(
      createMemoryRepository(),
      availableCodec,
      () => 'secret://facebook',
      () => NOW
    );
    const stored = await vault.put(descriptorInput, { username: 'thuan', password: RAW_PASSWORD });

    await expect(vault.resolve({ handle: stored.handle, ...request })).rejects.toThrow(message);
  });

  it('reveals only explicitly requested fields for a matching host capability', async () => {
    const vault = createSecretVault(
      createMemoryRepository(),
      availableCodec,
      () => 'secret://facebook',
      () => NOW
    );
    const stored = await vault.put(descriptorInput, { username: 'thuan', password: RAW_PASSWORD });

    const resolved = await vault.resolve({
      handle: stored.handle,
      surface: 'browser',
      purpose: 'facebook-login',
      target: 'facebook.com',
      fields: ['username'],
    });

    expect(resolved).toEqual({ username: 'thuan' });
    expect(resolved).not.toHaveProperty('password');
  });

  it('honors expiry and revocation before decrypting a secret', async () => {
    const repository = createMemoryRepository();
    let now = NOW;
    const vault = createSecretVault(
      repository,
      availableCodec,
      () => 'secret://expiring',
      () => now
    );
    const stored = await vault.put(
      { ...descriptorInput, expiresAt: NOW + 10 },
      { username: 'thuan', password: RAW_PASSWORD }
    );
    now = NOW + 10;
    await expect(
      vault.resolve({
        handle: stored.handle,
        surface: 'browser',
        purpose: 'facebook-login',
        target: 'facebook.com',
        fields: ['username'],
      })
    ).rejects.toThrow('expired');

    now = NOW + 5;
    repository.records.forEach((item) => Object.assign(item, { revokedAt: now }));
    await expect(
      vault.resolve({
        handle: stored.handle,
        surface: 'browser',
        purpose: 'facebook-login',
        target: 'facebook.com',
        fields: ['username'],
      })
    ).rejects.toThrow('revoked');
  });
  it('returns metadata without encrypted payload or raw secret values', async () => {
    const vault = createSecretVault(
      createMemoryRepository(),
      availableCodec,
      () => 'secret://facebook',
      () => NOW
    );
    await vault.put(descriptorInput, { username: 'thuan', password: RAW_PASSWORD });

    const metadata = await vault.list();
    const serialized = JSON.stringify(metadata);

    expect(serialized).not.toContain('encryptedPayload');
    expect(serialized).not.toContain(RAW_PASSWORD);
  });
});
