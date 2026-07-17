import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bridge } from '@office-ai/platform';
import { getAssistantsDir } from '@process/utils/initStorage';

export type AssistantResourceKind = 'rule' | 'skill';

const safeSegment = (value: string, label: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized !== path.basename(normalized) || normalized.includes('..')) {
    throw new Error(`${label} must be a safe identifier.`);
  }
  return normalized.replace(/[^a-zA-Z0-9._-]/g, '_');
};

export class AssistantResourceStore {
  constructor(private readonly root: string) {}

  async read(input: { assistant_id: string; locale?: string }, kind: AssistantResourceKind): Promise<string> {
    try {
      return await readFile(this.filePath(input, kind), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw error;
    }
  }

  async write(
    input: { assistant_id: string; content: string; locale?: string },
    kind: AssistantResourceKind
  ): Promise<boolean> {
    const target = this.filePath(input, kind);
    await mkdir(this.root, { recursive: true });
    const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, input.content, 'utf8');
    await rename(temporary, target);
    return true;
  }

  async remove(input: { assistant_id: string }, kind: AssistantResourceKind): Promise<boolean> {
    const id = safeSegment(input.assistant_id, 'assistant_id');
    const prefix = kind === 'skill' ? `${id}-skills.` : `${id}.`;
    let removed = false;
    try {
      const { readdir } = await import('node:fs/promises');
      for (const entry of await readdir(this.root)) {
        if (!entry.startsWith(prefix) || !entry.endsWith('.md')) continue;
        await rm(path.join(this.root, entry), { force: true });
        removed = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    return removed;
  }

  private filePath(input: { assistant_id: string; locale?: string }, kind: AssistantResourceKind): string {
    const id = safeSegment(input.assistant_id, 'assistant_id');
    const locale = safeSegment(input.locale?.trim() || 'en-US', 'locale');
    return path.join(this.root, kind === 'skill' ? `${id}-skills.${locale}.md` : `${id}.${locale}.md`);
  }
}

export const assistantResourceChannels = {
  readRule: bridge.buildProvider<string, { assistant_id: string; locale?: string }>('assistant-resource.read-rule'),
  writeRule: bridge.buildProvider<boolean, { assistant_id: string; content: string; locale?: string }>(
    'assistant-resource.write-rule'
  ),
  deleteRule: bridge.buildProvider<boolean, { assistant_id: string }>('assistant-resource.delete-rule'),
  readSkill: bridge.buildProvider<string, { assistant_id: string; locale?: string }>('assistant-resource.read-skill'),
  writeSkill: bridge.buildProvider<boolean, { assistant_id: string; content: string; locale?: string }>(
    'assistant-resource.write-skill'
  ),
  deleteSkill: bridge.buildProvider<boolean, { assistant_id: string }>('assistant-resource.delete-skill'),
};

let assistantResourceStore: AssistantResourceStore | undefined;
export const getAssistantResourceStore = (): AssistantResourceStore => {
  assistantResourceStore ??= new AssistantResourceStore(getAssistantsDir());
  return assistantResourceStore;
};

export const registerAssistantResourceBridge = (store = getAssistantResourceStore()): void => {
  assistantResourceChannels.readRule.provider((input) => store.read(input, 'rule'));
  assistantResourceChannels.writeRule.provider((input) => store.write(input, 'rule'));
  assistantResourceChannels.deleteRule.provider((input) => store.remove(input, 'rule'));
  assistantResourceChannels.readSkill.provider((input) => store.read(input, 'skill'));
  assistantResourceChannels.writeSkill.provider((input) => store.write(input, 'skill'));
  assistantResourceChannels.deleteSkill.provider((input) => store.remove(input, 'skill'));
};
