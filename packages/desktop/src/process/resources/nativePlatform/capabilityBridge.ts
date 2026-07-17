import os from 'node:os';
import path from 'node:path';
import { app } from 'electron';
import { bridge } from '@office-ai/platform';
import type { IMcpServer } from '@/common/config/storage';
import { getSkillsDir } from '@process/utils/initStorage';
import { NativeMcpConfigScanner, NativeMcpProbe, type McpTestResult } from './mcpDrivers';
import { NativeSkillCatalog } from './skillCatalog';

import { McpOAuthVault, NativeMcpOAuthService } from './oauthDriver';

export const nativeCapabilityChannels = {
  mcpConfigs: bridge.buildProvider<
    Array<{ source: string; servers: Array<IMcpServer & { importable: boolean; import_skip_reason?: string }> }>,
    Array<{ agent_type: string; backend?: string; name: string; cli_path?: string }>
  >('native-mcp.agent-configs'),
  mcpTest: bridge.buildProvider<McpTestResult, IMcpServer>('native-mcp.test'),

  oauthStatus: bridge.buildProvider<{ authenticated: boolean }, { server_url: string }>('native-mcp.oauth-status'),
  oauthLogin: bridge.buildProvider<{ success: boolean; error?: string }, { server_url: string }>(
    'native-mcp.oauth-login'
  ),
  oauthLogout: bridge.buildProvider<void, { server_url: string }>('native-mcp.oauth-logout'),
  oauthAuthenticated: bridge.buildProvider<string[], void>('native-mcp.oauth-authenticated'),
  skillList: bridge.buildProvider<Awaited<ReturnType<NativeSkillCatalog['list']>>, void>('native-skills.list'),
  skillMaterialize: bridge.buildProvider<
    { skills: Array<{ name: string; source_path: string }> },
    { conversation_id: string; skills: string[] }
  >('native-skills.materialize'),
  skillInfo: bridge.buildProvider<{ name: string; description: string }, { skill_path: string }>('native-skills.info'),
  skillImport: bridge.buildProvider<{ skill_name: string }, { skill_path: string }>('native-skills.import'),
  skillScan: bridge.buildProvider<Awaited<ReturnType<NativeSkillCatalog['scan']>>, { folder_path: string }>(
    'native-skills.scan'
  ),
  skillCommonPaths: bridge.buildProvider<Array<{ name: string; path: string }>, void>('native-skills.common-paths'),
  skillDetectExternal: bridge.buildProvider<Awaited<ReturnType<NativeSkillCatalog['detectExternal']>>, void>(
    'native-skills.detect-external'
  ),
  skillImportLink: bridge.buildProvider<{ skill_name: string }, { skill_path: string }>('native-skills.import-link'),
  skillDelete: bridge.buildProvider<void, { skill_name: string }>('native-skills.delete'),
  skillPaths: bridge.buildProvider<{ user_skills_dir: string; builtin_skills_dir: string }, void>(
    'native-skills.paths'
  ),
  skillExternalPaths: bridge.buildProvider<Array<{ name: string; path: string }>, void>('native-skills.external-paths'),
  skillExternalAdd: bridge.buildProvider<void, { name: string; path: string }>('native-skills.external-add'),
  skillExternalRemove: bridge.buildProvider<void, { path: string }>('native-skills.external-remove'),
};

const defaultBuiltinRoots = (): string[] => [
  path.join(process.cwd(), '.claude', 'skills'),
  path.join(process.resourcesPath, 'skills'),
];
export const createNativeSkillCatalog = (): NativeSkillCatalog =>
  new NativeSkillCatalog(
    getSkillsDir(),
    defaultBuiltinRoots(),
    path.join(app.getPath('userData'), 'tomny-core', 'materialized-skills')
  );

export const registerNativeCapabilityBridge = (
  probe = new NativeMcpProbe(),
  scanner = new NativeMcpConfigScanner(),
  skills = createNativeSkillCatalog(),
  oauth = new NativeMcpOAuthService(
    new McpOAuthVault(path.join(app.getPath('userData'), 'tomny-core', 'mcp-oauth.enc'))
  )
): void => {
  nativeCapabilityChannels.mcpConfigs.provider(() => scanner.scan());
  nativeCapabilityChannels.mcpTest.provider((server) => probe.test(server));

  nativeCapabilityChannels.oauthStatus.provider(({ server_url }) => oauth.status(server_url));
  nativeCapabilityChannels.oauthLogin.provider(({ server_url }) => oauth.login(server_url));
  nativeCapabilityChannels.oauthLogout.provider(({ server_url }) => oauth.logout(server_url));
  nativeCapabilityChannels.oauthAuthenticated.provider(() => oauth.authenticated());
  nativeCapabilityChannels.skillList.provider(() => skills.list());
  nativeCapabilityChannels.skillMaterialize.provider(({ conversation_id, skills: names }) =>
    skills.materialize(conversation_id, names)
  );
  nativeCapabilityChannels.skillInfo.provider(({ skill_path }) => skills.info(skill_path));
  nativeCapabilityChannels.skillImport.provider(({ skill_path }) => skills.import(skill_path));
  nativeCapabilityChannels.skillScan.provider(({ folder_path }) => skills.scan(folder_path));
  nativeCapabilityChannels.skillCommonPaths.provider(() => skills.commonPaths(os.homedir()));
  nativeCapabilityChannels.skillDetectExternal.provider(() => skills.detectExternal());
  nativeCapabilityChannels.skillImportLink.provider(({ skill_path }) => skills.import(skill_path, true));
  nativeCapabilityChannels.skillDelete.provider(({ skill_name }) => skills.remove(skill_name));
  nativeCapabilityChannels.skillPaths.provider(() => ({
    user_skills_dir: getSkillsDir(),
    builtin_skills_dir: defaultBuiltinRoots()[0],
  }));
  nativeCapabilityChannels.skillExternalPaths.provider(() => skills.getExternal());
  nativeCapabilityChannels.skillExternalAdd.provider((input) => skills.addExternal(input));
  nativeCapabilityChannels.skillExternalRemove.provider(({ path: externalPath }) =>
    skills.removeExternal(externalPath)
  );
};
