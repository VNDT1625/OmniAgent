import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { shell, safeStorage } from 'electron';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';

type OAuthRecord = { client?: OAuthClientInformationMixed; tokens?: OAuthTokens; verifier?: string };
type OAuthRecords = Record<string, OAuthRecord>;

export class McpOAuthVault {
  constructor(private readonly filePath: string) {}
  async get(serverUrl: string): Promise<OAuthRecord> {
    return (await this.read())[serverUrl] ?? {};
  }
  async set(serverUrl: string, value: OAuthRecord): Promise<void> {
    const records = await this.read();
    records[serverUrl] = value;
    await this.write(records);
  }
  async remove(serverUrl: string): Promise<void> {
    const records = await this.read();
    delete records[serverUrl];
    if (Object.keys(records).length === 0) await rm(this.filePath, { force: true });
    else await this.write(records);
  }
  async authenticated(): Promise<string[]> {
    const records = await this.read();
    return Object.entries(records)
      .filter(([, value]) => Boolean(value.tokens?.access_token))
      .map(([url]) => url);
  }
  private async read(): Promise<OAuthRecords> {
    try {
      const encrypted = Buffer.from(await readFile(this.filePath, 'utf8'), 'base64');
      return JSON.parse(safeStorage.decryptString(encrypted)) as OAuthRecords;
    } catch {
      return {};
    }
  }
  private async write(value: OAuthRecords): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is unavailable.');
    await mkdir(path.dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, safeStorage.encryptString(JSON.stringify(value)).toString('base64'), 'utf8');
  }
}

class DesktopOAuthProvider implements OAuthClientProvider {
  private record: OAuthRecord = {};
  constructor(
    private readonly serverUrl: string,
    readonly redirectUrl: URL,
    private readonly oauthState: string,
    private readonly vault: McpOAuthVault,
    private readonly open: (url: string) => Promise<void>
  ) {}
  state(): string {
    return this.oauthState;
  }
  readonly clientMetadata = {
    client_name: 'Tomny Agentic',
    redirect_uris: [this.redirectUrl.toString()],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
  async load(): Promise<void> {
    this.record = await this.vault.get(this.serverUrl);
  }
  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.record.client;
  }
  async saveClientInformation(client: OAuthClientInformationMixed): Promise<void> {
    this.record.client = client;
    await this.persist();
  }
  tokens(): OAuthTokens | undefined {
    return this.record.tokens;
  }
  async saveTokens(tokens: OAuthTokens): Promise<void> {
    this.record.tokens = tokens;
    await this.persist();
  }
  async redirectToAuthorization(url: URL): Promise<void> {
    await this.open(url.toString());
  }
  async saveCodeVerifier(verifier: string): Promise<void> {
    this.record.verifier = verifier;
    await this.persist();
  }
  codeVerifier(): string {
    if (!this.record.verifier) throw new Error('OAuth verifier is missing.');
    return this.record.verifier;
  }
  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    if (scope === 'all') this.record = {};
    else if (scope === 'client') delete this.record.client;
    else if (scope === 'tokens') delete this.record.tokens;
    else if (scope === 'verifier') delete this.record.verifier;
    await this.persist();
  }
  private persist(): Promise<void> {
    return this.vault.set(this.serverUrl, this.record);
  }
}

const callbackListener = async (): Promise<{
  redirectUrl: URL;
  state: string;
  code: Promise<string>;
  close: () => void;
}> => {
  const state = randomBytes(24).toString('base64url');
  let resolveCode!: (value: string) => void;
  let rejectCode!: (reason: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.searchParams.get('state') !== state) {
      response.writeHead(400).end('Invalid OAuth state.');
      rejectCode(new Error('OAuth state mismatch.'));
      return;
    }
    const value = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (!value) {
      response.writeHead(400).end('Authorization failed.');
      rejectCode(new Error(error || 'OAuth authorization code is missing.'));
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      .end('Authorization complete. You can return to Tomny.');
    resolveCode(value);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('OAuth callback listener failed.');
  return {
    redirectUrl: new URL(`http://127.0.0.1:${address.port}/callback`),
    state,
    code,
    close: () => server.close(),
  };
};

export class NativeMcpOAuthService {
  constructor(
    private readonly vault: McpOAuthVault,
    private readonly open = (url: string): Promise<void> => shell.openExternal(url).then(() => undefined),
    private readonly timeoutMs = 180_000
  ) {}
  async status(serverUrl: string): Promise<{ authenticated: boolean }> {
    return { authenticated: (await this.vault.authenticated()).includes(serverUrl) };
  }
  authenticated(): Promise<string[]> {
    return this.vault.authenticated();
  }
  async logout(serverUrl: string): Promise<void> {
    await this.vault.remove(serverUrl);
  }
  async login(serverUrl: string): Promise<{ success: boolean; error?: string }> {
    const callback = await callbackListener();
    const provider = new DesktopOAuthProvider(serverUrl, callback.redirectUrl, callback.state, this.vault, this.open);
    await provider.load();
    try {
      const result = await auth(provider, { serverUrl });
      if (result === 'AUTHORIZED') return { success: true };
      const authorizationCode = await Promise.race([
        callback.code,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('OAuth login timed out.')), this.timeoutMs)
        ),
      ]);
      await auth(provider, { serverUrl, authorizationCode });
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    } finally {
      callback.close();
    }
  }
}
