import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { TTeam } from '@/common/types/team/teamTypes';

type TeamDocument = { version: 1; teams: TTeam[] };
const clone = <T>(value: T): T => structuredClone(value);
const isTeam = (value: unknown): value is TTeam => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<TTeam>;
  return typeof candidate.id === 'string' && typeof candidate.user_id === 'string' && Array.isArray(candidate.agents);
};

/** Durable, atomic Team metadata store owned by the Tomny main process. */
export class JsonTeamStore {
  private mutations: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}

  private async readDocument(): Promise<TeamDocument> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<TeamDocument> | TTeam[];
      const teams = Array.isArray(parsed) ? parsed : parsed.teams;
      return { version: 1, teams: Array.isArray(teams) ? teams.filter(isTeam).map(clone) : [] };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || error instanceof SyntaxError) return { version: 1, teams: [] };
      throw error;
    }
  }

  private async writeDocument(document: TeamDocument): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, this.filePath);
  }

  async list(): Promise<TTeam[]> {
    await this.mutations;
    return (await this.readDocument()).teams.map(clone);
  }

  async get(id: string): Promise<TTeam | null> {
    return (await this.list()).find((team) => team.id === id) ?? null;
  }

  async transact<T>(mutation: (teams: TTeam[]) => T | Promise<T>): Promise<T> {
    let resolveResult!: (value: T) => void;
    let rejectResult!: (reason: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    this.mutations = this.mutations
      .then(async () => {
        const document = await this.readDocument();
        const value = await mutation(document.teams);
        await this.writeDocument(document);
        resolveResult(clone(value));
      })
      .catch((error: unknown) => rejectResult(error));
    return result;
  }
}
