import { cp, lstat, mkdir, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type SkillSummary = {
  name: string;
  description: string;
  location: string;
  relative_location?: string;
  is_custom: boolean;
  source: 'builtin' | 'custom' | 'extension';
};
export type DetectedSkill = { name: string; description: string; path: string };

const parseMetadata = (content: string, fallback: string): { name: string; description: string } => {
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const body = frontmatter?.[1] ?? '';
  const name = body.match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() || fallback;
  const description =
    body.match(/^description:\s*[>|]?-?\s*(.*)$/m)?.[1]?.trim() ||
    content
      .replace(/^---[\s\S]*?---/, '')
      .trim()
      .split(/\r?\n\r?\n/)[0]
      ?.slice(0, 240) ||
    '';
  return { name, description };
};

const scanRoot = async (root: string, maxDepth = 4): Promise<DetectedSkill[]> => {
  const found: DetectedSkill[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
        const metadata = parseMetadata(await readFile(target, 'utf8'), path.basename(directory));
        found.push({ ...metadata, path: directory });
      } else if (entry.isDirectory()) await visit(target, depth + 1);
    }
  };
  await visit(path.resolve(root), 0);
  return found;
};

export class NativeSkillCatalog {
  private readonly externalFile: string;
  constructor(
    private readonly userRoot: string,
    private readonly builtinRoots: string[],
    private readonly materializedRoot: string
  ) {
    this.externalFile = path.join(path.dirname(userRoot), 'skill-external-paths.json');
  }
  async list(): Promise<SkillSummary[]> {
    const all: SkillSummary[] = [];
    for (const root of this.builtinRoots)
      for (const skill of await scanRoot(root))
        all.push({
          name: skill.name,
          description: skill.description,
          location: skill.path,
          relative_location: path.relative(root, skill.path),
          is_custom: false,
          source: 'builtin',
        });
    for (const skill of await scanRoot(this.userRoot))
      all.push({
        name: skill.name,
        description: skill.description,
        location: skill.path,
        relative_location: path.relative(this.userRoot, skill.path),
        is_custom: true,
        source: 'custom',
      });
    return [...new Map(all.map((skill) => [skill.name.toLowerCase(), skill])).values()];
  }
  async info(skillPath: string): Promise<{ name: string; description: string }> {
    return parseMetadata(
      await readFile(path.join(path.resolve(skillPath), 'SKILL.md'), 'utf8'),
      path.basename(skillPath)
    );
  }
  scan(folderPath: string): Promise<DetectedSkill[]> {
    return scanRoot(folderPath);
  }
  async import(skillPath: string, link = false): Promise<{ skill_name: string }> {
    const source = path.resolve(skillPath);
    const metadata = await this.info(source);
    const safeName = metadata.name.replace(/[^a-zA-Z0-9._-]+/g, '-');
    if (!safeName) throw new Error('Skill name is invalid.');
    const destination = path.join(this.userRoot, safeName);
    await mkdir(this.userRoot, { recursive: true });
    await rm(destination, { recursive: true, force: true });
    if (link) await symlink(source, destination, 'junction');
    else await cp(source, destination, { recursive: true, errorOnExist: true });
    return { skill_name: metadata.name };
  }
  async remove(name: string): Promise<void> {
    const target = path.resolve(this.userRoot, name);
    const root = path.resolve(this.userRoot);
    if (!target.startsWith(`${root}${path.sep}`)) throw new Error('Skill name escapes the skill directory.');
    await rm(target, { recursive: true, force: true });
  }
  async materialize(
    conversationId: string,
    names: string[]
  ): Promise<{ skills: Array<{ name: string; source_path: string }> }> {
    const available = await this.list();
    const byName = new Map(available.map((skill) => [skill.name.toLowerCase(), skill]));
    const targetRoot = path.join(this.materializedRoot, conversationId.replace(/[^a-zA-Z0-9._-]/g, '_'));
    await rm(targetRoot, { recursive: true, force: true });
    await mkdir(targetRoot, { recursive: true });
    const skills: Array<{ name: string; source_path: string }> = [];
    for (const name of names) {
      const skill = byName.get(name.toLowerCase());
      if (!skill) continue;
      const destination = path.join(targetRoot, path.basename(skill.location));
      await cp(skill.location, destination, { recursive: true });
      skills.push({ name: skill.name, source_path: destination });
    }
    return { skills };
  }
  async getExternal(): Promise<Array<{ name: string; path: string }>> {
    try {
      const data = JSON.parse(await readFile(this.externalFile, 'utf8'));
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }
  async addExternal(item: { name: string; path: string }): Promise<void> {
    const values = (await this.getExternal()).filter((value) => path.resolve(value.path) !== path.resolve(item.path));
    values.push({ name: item.name.trim() || path.basename(item.path), path: path.resolve(item.path) });
    await mkdir(path.dirname(this.externalFile), { recursive: true });
    await writeFile(this.externalFile, JSON.stringify(values, null, 2), 'utf8');
  }
  async removeExternal(externalPath: string): Promise<void> {
    const values = (await this.getExternal()).filter(
      (value) => path.resolve(value.path) !== path.resolve(externalPath)
    );
    await writeFile(this.externalFile, JSON.stringify(values, null, 2), 'utf8');
  }
  async detectExternal(): Promise<Array<{ name: string; path: string; source: string; skills: DetectedSkill[] }>> {
    const values = await this.getExternal();
    return Promise.all(
      values.map(async (value) => ({ ...value, source: 'custom', skills: await scanRoot(value.path) }))
    );
  }
  async commonPaths(home: string): Promise<Array<{ name: string; path: string }>> {
    const candidates = [
      { name: 'Claude', path: path.join(home, '.claude', 'skills') },
      { name: 'Codex', path: path.join(home, '.codex', 'skills') },
      { name: 'Kiro', path: path.join(home, '.kiro', 'skills') },
    ];
    const result = [];
    for (const item of candidates) {
      try {
        if ((await lstat(item.path)).isDirectory()) result.push(item);
      } catch {}
    }
    return result;
  }
}
