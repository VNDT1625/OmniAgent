import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADAPTER_CATALOG_SCHEMA_VERSION,
  AdapterCatalogError,
  AdapterCatalogStore,
  adapterCatalogPayload,
  createEd25519CatalogVerifier,
  hashAdapterCatalogPayload,
  validateAdapterCatalog,
} from '@process/experimentalCore/catalog';

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const document = (revision: string) => {
  const draft = {
    schemaVersion: ADAPTER_CATALOG_SCHEMA_VERSION,
    revision,
    coreCompatibility: { min: '0.1.0', max: '1.0.0' },
    definitions: [
      {
        id: 'custom',
        name: 'Custom ACP',
        protocol: 'acp' as const,
        candidates: ['custom-agent'],
        args: ['acp'],
        detail: 'test',
        runnable: true,
      },
    ],
  };
  return { ...draft, sha256: hashAdapterCatalogPayload(draft) };
};

describe('adapter catalog verification', () => {
  it('accepts canonical hash and rejects tampering or incompatible core', () => {
    const valid = document('r1');
    expect(validateAdapterCatalog(valid, { coreVersion: '0.2.0' }).revision).toBe('r1');
    expect(() => validateAdapterCatalog({ ...valid, definitions: [] })).toThrowError(AdapterCatalogError);
    expect(() => validateAdapterCatalog(valid, { coreVersion: '2.0.0' })).toThrow(/incompatible/i);
  });

  it('requires schema metadata and an integrity hash', () => {
    expect(() => validateAdapterCatalog([{ id: 'legacy' }])).toThrow(/schema document/i);
    const valid = document('r1');
    expect(() => validateAdapterCatalog({ ...valid, sha256: '0'.repeat(64) })).toThrow(/hash verification/i);
  });

  it('requires and cryptographically verifies Ed25519 signatures when configured', () => {
    const valid = document('signed');
    expect(() => validateAdapterCatalog(valid, { requireSignature: true })).toThrow(/signature is required/i);

    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const signature = sign(null, Buffer.from(adapterCatalogPayload(valid)), privateKey).toString('base64');
    const verifier = createEd25519CatalogVerifier(publicKey.export({ type: 'spki', format: 'der' }).toString('base64'));
    expect(
      validateAdapterCatalog({ ...valid, signature }, { requireSignature: true, verifySignature: verifier })
    ).toMatchObject({
      revision: 'signed',
    });
    expect(() =>
      validateAdapterCatalog(
        { ...valid, signature: `${signature.slice(0, -4)}AAAA` },
        { requireSignature: true, verifySignature: verifier }
      )
    ).toThrow(/signature verification/i);
  });
});

describe('adapter catalog store', () => {
  it('falls back to previous valid revision and honors a pin', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tomny-catalog-'));
    directories.push(directory);
    const active = path.join(directory, 'catalog.json');
    const store = new AdapterCatalogStore(active);
    await store.activate(document('r1'));
    await store.activate(document('r2'));
    await store.activate(document('r3'));
    await store.pin('r2');
    await writeFile(active, '{bad', 'utf8');
    expect((await store.load())?.revision).toBe('r2');
    expect(await readFile(`${active}.pin`, 'utf8')).toBe('r2');
  });
});
