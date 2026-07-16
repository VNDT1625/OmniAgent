/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for role capabilities (Requirement 9): the company config must persist
 * and round-trip a role's `capabilities` (MCP servers / skills / session mode)
 * on its assignment, and must defensively drop malformed capability data.
 */

import { describe, expect, it } from 'vitest';
import path from 'node:path';
import { createFromDescription } from '@/process/company/companyConfig';
import { createCompanyConfigStore, type CompanyConfig } from '@/process/company/companyConfig';

/** Path to a company's config file under a given root (mirrors the store). */
const configPath = (root: string, companyId: string): string => path.join(root, companyId, 'company.json');

/** An in-memory fs double good enough for the config store. */
const makeMemFs = () => {
  const files = new Map<string, string>();
  return {
    files,
    fs: {
      readFile: async (p: string) => {
        if (!files.has(p)) {
          const err = new Error('ENOENT') as NodeJS.ErrnoException;
          err.code = 'ENOENT';
          throw err;
        }
        return files.get(p) as string;
      },
      writeFile: async (p: string, data: string) => {
        files.set(p, data);
      },
      rename: async (a: string, b: string) => {
        files.set(b, files.get(a) as string);
        files.delete(a);
      },
      mkdir: async () => undefined,
      rm: async (dir: string) => {
        // Remove every file whose path is inside `dir` (recursive delete double).
        const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
        for (const key of files.keys()) {
          if (key === dir || key.startsWith(prefix)) files.delete(key);
        }
      },
    },
  };
};

describe('company config — role capabilities round-trip (Requirement 9)', () => {
  it('persists and reloads an assignment with capabilities', async () => {
    const mem = makeMemFs();
    const store = createCompanyConfigStore({ localRootDir: '/c', fs: mem.fs as never });

    const config: CompanyConfig = {
      companyId: 'co',
      rules: [],
      divisions: [
        {
          divisionId: 'arch',
          name: 'Architecture',
          workerCount: 1,
          assignment: {
            kind: 'cli',
            refId: 'claude',
            label: 'Claude Code',
            capabilities: {
              mcpServerIds: ['browser', 'office'],
              skills: ['edit-pptx'],
              sessionMode: 'bypassPermissions',
            },
          },
        },
      ],
    };

    await store.save('co', config);
    const reloaded = await store.load('co');
    const caps = reloaded.divisions[0].assignment?.capabilities;
    expect(caps).toBeDefined();
    expect(caps?.mcpServerIds).toEqual(['browser', 'office']);
    expect(caps?.skills).toEqual(['edit-pptx']);
    expect(caps?.sessionMode).toBe('bypassPermissions');
  });

  it('drops a malformed capabilities block on load (defensive)', async () => {
    const mem = makeMemFs();
    // Hand-write a config file with a junk capabilities shape.
    const raw = {
      companyId: 'co',
      rules: [],
      divisions: [
        {
          divisionId: 'be',
          name: 'Backend',
          workerCount: 0,
          assignment: {
            kind: 'cli',
            refId: 'codex',
            label: 'Codex',
            capabilities: { mcpServerIds: 'not-an-array', skills: [123], sessionMode: '' },
          },
        },
      ],
    };
    mem.files.set(configPath('/c', 'co'), JSON.stringify(raw));

    const store = createCompanyConfigStore({ localRootDir: '/c', fs: mem.fs as never });
    const reloaded = await store.load('co');
    // The assignment survives; the junk capabilities are dropped entirely.
    expect(reloaded.divisions[0].assignment?.kind).toBe('cli');
    expect(reloaded.divisions[0].assignment?.capabilities).toBeUndefined();
  });

  it('keeps only valid parts of a partially-malformed capabilities block', async () => {
    const mem = makeMemFs();
    const raw = {
      companyId: 'co',
      rules: [],
      divisions: [
        {
          divisionId: 'qa',
          name: 'QA',
          workerCount: 0,
          assignment: {
            kind: 'cli',
            refId: 'claude',
            label: 'Claude',
            capabilities: { mcpServerIds: ['testing', '', 'testing'], skills: 'bad', sessionMode: 'yolo' },
          },
        },
      ],
    };
    mem.files.set(configPath('/c', 'co'), JSON.stringify(raw));

    const store = createCompanyConfigStore({ localRootDir: '/c', fs: mem.fs as never });
    const caps = (await store.load('co')).divisions[0].assignment?.capabilities;
    expect(caps?.mcpServerIds).toEqual(['testing']); // de-duped, empties dropped
    expect(caps?.skills).toBeUndefined(); // 'bad' is not an array → dropped
    expect(caps?.sessionMode).toBe('yolo');
  });

  it('drops a model on a CLI assignment (CLI manages its own model)', async () => {
    const mem = makeMemFs();
    const raw = {
      companyId: 'co',
      rules: [],
      // A CLI assignment must NOT keep a (possibly invented) model id; an
      // assistant assignment keeps its model.
      presidentAssignment: { kind: 'cli', refId: 'codex', label: 'Codex CLI', model: 'gpt-5-codex' },
      divisions: [
        {
          divisionId: 'be',
          name: 'Backend',
          workerCount: 0,
          assignment: { kind: 'assistant', refId: 'a1', label: 'Helper', model: 'real-model' },
        },
      ],
    };
    mem.files.set(configPath('/c', 'co'), JSON.stringify(raw));

    const store = createCompanyConfigStore({ localRootDir: '/c', fs: mem.fs as never });
    const reloaded = await store.load('co');
    expect(reloaded.presidentAssignment?.kind).toBe('cli');
    expect(reloaded.presidentAssignment?.model).toBeUndefined(); // CLI model stripped
    expect(reloaded.divisions[0].assignment?.model).toBe('real-model'); // assistant model kept
  });
});

describe('createFromDescription — company rules (criterion 3.10)', () => {
  it('parses company-wide rules the designer returns', async () => {
    const generate = async () =>
      JSON.stringify({
        name: 'IT',
        rules: ['Architecture docs must be approved by the President', 'Every feature must pass QA', '', '  '],
        divisions: [{ divisionId: 'be', name: 'Backend', workerCount: 1 }],
      });

    const spec = await createFromDescription('build an app', { generate, companyId: 'co' });
    // Empty/whitespace rules are dropped; real ones are kept.
    expect(spec.rules).toEqual(['Architecture docs must be approved by the President', 'Every feature must pass QA']);
  });

  it('omits rules when the designer returns none', async () => {
    const generate = async () =>
      JSON.stringify({ name: 'IT', divisions: [{ divisionId: 'be', name: 'Backend', workerCount: 1 }] });
    const spec = await createFromDescription('build an app', { generate, companyId: 'co' });
    expect(spec.rules).toBeUndefined();
  });
});

describe('company config — deleteCompany (full reset)', () => {
  it('removes the company folder so a re-create starts fresh', async () => {
    const mem = makeMemFs();
    const store = createCompanyConfigStore({ localRootDir: '/c', fs: mem.fs as never });

    // Seed a company with rules + an assignment, then save it.
    await store.save('co', {
      companyId: 'co',
      rules: ['must approve plans'],
      divisions: [{ divisionId: 'be', name: 'Backend', workerCount: 1 }],
      presidentAssignment: { kind: 'assistant', refId: 'a1', label: 'Boss' },
    });
    expect(mem.files.has(configPath('/c', 'co'))).toBe(true);

    const res = await store.deleteCompany('co');
    expect(res.deleted).toBe(true);
    expect(mem.files.has(configPath('/c', 'co'))).toBe(false);

    // A fresh load returns an empty config — no stale rules / assignment linger.
    const reloaded = await store.load('co');
    expect(reloaded.rules).toEqual([]);
    expect(reloaded.divisions).toEqual([]);
    expect(reloaded.presidentAssignment).toBeUndefined();
  });

  it('reports deleted=false when the company does not exist', async () => {
    const mem = makeMemFs();
    const store = createCompanyConfigStore({ localRootDir: '/c', fs: mem.fs as never });
    const res = await store.deleteCompany('ghost');
    expect(res.deleted).toBe(false);
  });

  it('rejects an unsafe company id (path traversal guard)', async () => {
    const mem = makeMemFs();
    const store = createCompanyConfigStore({ localRootDir: '/c', fs: mem.fs as never });
    await expect(store.deleteCompany('../escape')).rejects.toThrow();
  });
});
