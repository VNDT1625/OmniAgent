/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the IDE repo-intelligence IPC surface.
 *
 * The Main-process bridges (`process/ide/ideBridge.ts`, `ideWikiBridge.ts`,
 * `ideFileBridge.ts`, `knowledgeGraphBridge.ts`) import Node-only modules, so
 * they must not be loaded in the renderer.
 * Mirroring `studioChatClient.ts`, this module re-declares the channel-name
 * strings, rebuilds matching `bridge.buildProvider` invokers, and borrows only
 * **types** via `import type`.
 *
 * `scanRepo` walks a folder in the Main process (timeout-guarded — a large repo
 * still returns quickly thanks to the file cap). The Chat surface uses the main
 * conversation/CLI-agent system directly; this client no longer carries an
 * explain or in-IDE code-agent channel (both were removed in favour of
 * embedding `<ChatConversation>`).
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type { IdeScanResult, ScanRepoRequest } from '@process/ide/ideBridge';
import type { RepoGraph } from '@process/ide/repoGraph';
import type { IdeWikiResult, WikiPlan, WikiPlanRequest, WikiSectionRequest } from '@process/ide/ideWikiBridge';
import type {
  WikiBuildRequest,
  WikiCancelRequest,
  WikiLoadRequest,
  WikiBuildProgress,
  PersistedWiki,
} from '@process/ide/wiki/wikiBuildBridge';
import type {
  IdeDirEntry,
  IdeFileChangeEvent,
  IdeFileResult,
  IdeFileWatchStartRequest,
  IdeFileWatchStopRequest,
  ListDirRequest,
  ReadFileData,
  ReadFileRequest,
  WriteFileBase64Request,
  WriteFileRequest,
  LoadRulesRequest,
} from '@process/ide/ideFileBridge';
import type {
  GitChange,
  GitDiffRequest,
  GitRevertRequest,
  GitStatusRequest,
  IdeGitResult,
} from '@process/ide/ideGitBridge';
import type {
  KnowledgeBuildRequest,
  KnowledgeBuildStatus,
  KnowledgeEventEnvelope,
  KnowledgeGetRequest,
  KnowledgeStatusRequest,
  KnowledgeWatchStartRequest,
  KnowledgeWatchStopRequest,
  KnowledgeChangedEnvelope,
  KnowledgeDiffRequest,
  KnowledgeContextRequest,
  KnowledgeRefreshFileRequest,
} from '@process/ide/knowledgeGraphBridge';
import type { QtStartRequest, QtStopResponse, QtEventEnvelope } from '@process/ide/quickTestBridge';
import type {
  InspectPickRequest,
  InspectScreenshotRequest,
  InspectScreenshotResult,
  InspectVideoResult,
} from '@process/ide/elementInspectorBridge';
import type { UiAuditReport } from '@process/ide/uiAuditEngine';
import type {
  ArchiveRunRequest,
  CompareRunsRequest,
  CompareVisualRequest,
  QuickTestAssetState,
  RemoveAssetRequest,
  ReplayScenarioRequest,
  SaveBaselineRequest,
  SaveScenarioRequest,
  StoredQuickTestRun,
} from '@process/ide/quickTestAssetBridge';
import type { ReplayRunResult, ReplayScenario } from '@process/ide/quickTestReplay';
import type { QuickTestRunDiff } from '@process/ide/quickTestRunCompare';
import type { VisualBaseline, VisualComparisonResult } from '@process/ide/quickTestVisualRegression';
import type {
  ApplyRetentionRequest,
  EditScenarioRequest,
  EditScenarioResult,
  EnvironmentRequest,
  ExportReportRequest,
  ExportReportResult,
  ListMocksRequest,
  MockRuleState,
  ObservabilityRequest,
  ObservabilityResult,
  ReliabilityRequest,
  ReliabilityResult,
  RemoveMockRequest,
  RepeatReplayRequest,
  RepeatReplayResult,
  RetentionRequest,
  SaveMockRequest,
} from '@process/ide/quickTestInsightsBridge';
import type { ApiMockRule } from '@process/services/quick-test/observability';
import type { EnvironmentSnapshot } from '@process/services/quick-test/reliability';
import type { RetentionCleanupPlan } from '@process/services/quick-test/workflow';
import type { LocatedElement } from '@process/ide/elementInspectorLocator';

/** Extract plain text content from a `ide.read-file` result (supports both legacy string and the current ReadFileData shape). */
export const getReadFileText = (data: ReadFileData | string | null | undefined): string =>
  typeof data === 'string' ? data : (data?.text ?? '');
import type { TracePlatform as QtTracePlatform } from '@process/ide/quickTestTracer';
import type {
  RunPlanRequest,
  RunPlanResponse,
  RunSaveRequest,
  RunClearRequest,
  RunProbeRequest,
  RunProbeResponse,
  RunTargetResult,
} from '@process/ide/runTarget/runTargetBridge';
import type { RepoRunConfigs, SavedRunConfig } from '@process/ide/runTarget/runConfigStore';
import type { RunPlan, RunCandidate, RunPlatform, PlatformSupport } from '@process/ide/runTarget/runTargetPlanner';
import type {
  SpecFileName,
  SpecInitRequest,
  SpecListEntry,
  SpecLifecycleStatus,
  SpecReadRequest,
  SpecResult,
  SpecStatusRequest,
  SpecSetActiveRequest,
  SpecAdvancePhaseRequest,
  SpecApprovalGate,
  SpecTaskClaimRequest,
  SpecTaskListRequest,
  SpecTaskRunbook,
  SpecTaskUpdateRequest,
  SpecWriteRequest,
  SpecAnalyzeRequest,
} from '@process/ide/specLifecycleBridge';
import type { SpecAnalysis } from '@/common/spec';
import type {
  MtuiPolicyCheckRequest,
  MtuiPolicyCheckResult,
  MtuiPolicyResult,
} from '@process/terminal/mtuiPolicyBridge';
import type {
  GrepRequest,
  IdeGrepMatch,
  IdeSearchResult,
  ReplaceFileRequest,
} from '@process/ide/search/ideSearchBridge';
import type { IdeLintResult, LintFileRequest } from '@process/ide/lint/ideLintBridge';
import type { IdeNavResult, NavRequest, NavHit } from '@process/ide/nav/ideNavBridge';
import type { IdeLangResult, AnalyzeLanguagesRequest } from '@process/ide/lang/ideLangBridge';
import type { IdeCompletionResult, InlineCompleteRequest } from '@process/ide/lang/ideCompletionBridge';
import type {
  IdeMemoryResult,
  IdeMemoryRequest,
  IdeMemoryRememberRequest,
  IdeMemoryRecordableKind,
  RepoSecretDeclareRequest,
  RepoSecretListRequest,
  RepoSecretRemoveRequest,
  RepoSecretRevealRequest,
  RepoSecretRenderMarkersRequest,
  RepoSecretSaveRequest,
} from '@process/ide/memory/ideMemoryBridge';
import type { RepoSecretContext, RepoSecretMarkerRender } from '@process/ide/memory/repoSecretStore';
import type { SuperMemorySnapshot, RememberResult } from '@process/ide/memory/sessionMemoryStore';
import type { IdeCommandResult, RunCommandRequest } from '@process/ide/command/commandBridge';
import type { CommandResult } from '@process/ide/command/commandRunner';
import type {
  KnowledgeBuildPhase,
  KnowledgeGraph,
  KnowledgeNode,
  RepoChangeEvent,
  UnderstandResult,
  GraphDiff,
  ContextPack,
} from '@process/ide/understandTypes';

/** IDE IPC channel names (mirror of the bridge channel consts). */
const IDE_CHANNELS = {
  scanRepo: 'ide.scan-repo',
  wikiPlan: 'ide.wiki-plan',
  wikiSection: 'ide.wiki-section',
  wikiBuild: 'ide.wiki-build',
  wikiCancel: 'ide.wiki-cancel',
  wikiLoad: 'ide.wiki-load',
  wikiProgress: 'ide.wiki-progress',
  listDir: 'ide.list-dir',
  readFile: 'ide.read-file',
  readFileBase64: 'ide.read-file-base64',
  writeFile: 'ide.write-file',
  writeFileBase64: 'ide.write-file-base64',
  fileWatchStart: 'ide.file-watch-start',
  fileWatchStop: 'ide.file-watch-stop',
  fileChanged: 'ide.file-changed',
  deleteFile: 'ide.delete-file',
  createDir: 'ide.create-dir',
  renameFile: 'ide.rename-file',
  rulesLoad: 'ide.rules-load',
  kgBuild: 'ide.kg-build',
  kgStatus: 'ide.kg-status',
  kgGet: 'ide.kg-get',
  kgEvent: 'ide.kg-event',
  kgWatchStart: 'ide.kg-watch-start',
  kgWatchStop: 'ide.kg-watch-stop',
  kgChanged: 'ide.kg-changed',
  kgDiff: 'ide.kg-diff',
  kgContext: 'ide.kg-context',
  kgRefreshFile: 'ide.kg-refresh-file',
  qtStart: 'ide.qt-start',
  qtStop: 'ide.qt-stop',
  qtEvent: 'ide.qt-event',
  qtAssetsList: 'ide.qt-assets-list',
  qtAssetsArchiveRun: 'ide.qt-assets-archive-run',
  qtAssetsSaveScenario: 'ide.qt-assets-save-scenario',
  qtAssetsReplay: 'ide.qt-assets-replay',
  qtAssetsCompareRuns: 'ide.qt-assets-compare-runs',
  qtAssetsSaveBaseline: 'ide.qt-assets-save-baseline',
  qtAssetsCompareVisual: 'ide.qt-assets-compare-visual',
  qtAssetsRemove: 'ide.qt-assets-remove',
  qtInsightsObservability: 'ide.qt-insights-observability',
  qtInsightsReliability: 'ide.qt-insights-reliability',
  qtInsightsEnvironment: 'ide.qt-insights-environment',
  qtInsightsRepeatReplay: 'ide.qt-insights-repeat-replay',
  qtInsightsListMocks: 'ide.qt-insights-list-mocks',
  qtInsightsSaveMock: 'ide.qt-insights-save-mock',
  qtInsightsRemoveMock: 'ide.qt-insights-remove-mock',
  qtInsightsExportReport: 'ide.qt-insights-export-report',
  qtInsightsPreviewCleanup: 'ide.qt-insights-preview-cleanup',
  qtInsightsApplyCleanup: 'ide.qt-insights-apply-cleanup',
  qtInsightsEditScenario: 'ide.qt-insights-edit-scenario',
  inspectPick: 'ide.inspect-pick',
  inspectCancel: 'ide.inspect-cancel',
  inspectScreenshot: 'ide.inspect-screenshot',
  inspectVideoStart: 'ide.inspect-video-start',
  inspectVideoStop: 'ide.inspect-video-stop',
  inspectAudit: 'ide.ui-audit',
  qrPlan: 'ide.qr-plan',
  qrSave: 'ide.qr-save',
  qrClear: 'ide.qr-clear',
  qrProbe: 'ide.qr-probe',
  specStatus: 'ide.spec-status',
  specInit: 'ide.spec-init',
  specRead: 'ide.spec-read',
  specWrite: 'ide.spec-write',
  specList: 'ide.spec-list',
  specSetActive: 'ide.spec-set-active',
  specAdvancePhase: 'ide.spec-advance-phase',
  specTaskList: 'ide.spec-task-list',
  specTaskClaim: 'ide.spec-task-claim',
  specTaskUpdate: 'ide.spec-task-update',
  specAnalyze: 'ide.spec-analyze',
  gitStatus: 'ide.git-status',
  gitDiff: 'ide.git-diff',
  gitRevertFile: 'ide.git-revert-file',
  grep: 'ide.grep',
  replaceFile: 'ide.replace-file',
  lintFile: 'ide.lint-file',
  findDefinition: 'ide.find-definition',
  findReferences: 'ide.find-references',
  analyzeLanguages: 'ide.analyze-languages',
  inlineComplete: 'ide.inline-complete',
  memorySnapshot: 'ide.memory-snapshot',
  memoryClear: 'ide.memory-clear',
  memoryRemember: 'ide.memory-remember',
  repoSecretList: 'ide.repo-secret-list',
  repoSecretSave: 'ide.repo-secret-save',
  repoSecretDeclare: 'ide.repo-secret-declare',
  repoSecretRemove: 'ide.repo-secret-remove',
  repoSecretReveal: 'ide.repo-secret-reveal',
  repoSecretRenderMarkers: 'ide.repo-secret-render-markers',
  runCommand: 'ide.run-command',
  mtuiPolicyCheck: 'terminal.mtui-policy-check',
} as const;

/** Timeout (ms) for a repo scan. */
const SCAN_TIMEOUT_MS = 30000;
/** Timeout (ms) for the wiki plan (a scan + a fs read of the key files). */
const WIKI_PLAN_TIMEOUT_MS = 45000;
/** Timeout (ms) for authoring a single wiki section (a provider completion). */
const WIKI_SECTION_TIMEOUT_MS = 120000;
/** Timeout (ms) for a full durable-wiki build (scan + verify + many refined sections). */
const WIKI_BUILD_TIMEOUT_MS = 1800000;
/** Timeout (ms) for a filesystem op (Node fs round-trip; fast). */
const FILE_OP_TIMEOUT_MS = 15000;
const UI_AUDIT_TIMEOUT_MS = 60000;
/** Timeout (ms) for an inline completion (a provider call; must feel snappy). */
const INLINE_COMPLETE_TIMEOUT_MS = 8000;
/** Timeout (ms) for a full knowledge-graph build (scan + many sequential model calls). */
const KG_BUILD_TIMEOUT_MS = 3600000;

/** Timeout (ms) for a guarded shell command invoked through the IDE plane. */
const COMMAND_TIMEOUT_MS = 60000;
/** Timeout (ms) for an element pick — generous because it waits for a human click. */
const INSPECT_TIMEOUT_MS = 300000;

/** Raw typed invokers — each `.invoke(req)` round-trips to the Main process. */
const channels = {
  scanRepo: bridge.buildProvider<IdeScanResult, ScanRepoRequest>(IDE_CHANNELS.scanRepo),
  wikiPlan: bridge.buildProvider<IdeWikiResult<WikiPlan>, WikiPlanRequest>(IDE_CHANNELS.wikiPlan),
  wikiSection: bridge.buildProvider<IdeWikiResult<string>, WikiSectionRequest>(IDE_CHANNELS.wikiSection),
  wikiBuild: bridge.buildProvider<IdeWikiResult<PersistedWiki>, WikiBuildRequest>(IDE_CHANNELS.wikiBuild),
  wikiCancel: bridge.buildProvider<IdeWikiResult<boolean>, WikiCancelRequest>(IDE_CHANNELS.wikiCancel),
  wikiLoad: bridge.buildProvider<IdeWikiResult<PersistedWiki | null>, WikiLoadRequest>(IDE_CHANNELS.wikiLoad),
  wikiProgress: bridge.buildEmitter<WikiBuildProgress>(IDE_CHANNELS.wikiProgress),
  listDir: bridge.buildProvider<IdeFileResult<IdeDirEntry[]>, ListDirRequest>(IDE_CHANNELS.listDir),
  readFile: bridge.buildProvider<IdeFileResult<ReadFileData>, ReadFileRequest>(IDE_CHANNELS.readFile),
  readFileBase64: bridge.buildProvider<IdeFileResult<string>, ReadFileRequest>(IDE_CHANNELS.readFileBase64),
  writeFile: bridge.buildProvider<IdeFileResult<boolean>, WriteFileRequest>(IDE_CHANNELS.writeFile),
  writeFileBase64: bridge.buildProvider<IdeFileResult<boolean>, WriteFileBase64Request>(IDE_CHANNELS.writeFileBase64),
  fileWatchStart: bridge.buildProvider<IdeFileResult<boolean>, IdeFileWatchStartRequest>(IDE_CHANNELS.fileWatchStart),
  fileWatchStop: bridge.buildProvider<IdeFileResult<boolean>, IdeFileWatchStopRequest>(IDE_CHANNELS.fileWatchStop),
  fileChanged: bridge.buildEmitter<{ event: IdeFileChangeEvent }>(IDE_CHANNELS.fileChanged),
  deleteFile: bridge.buildProvider<IdeFileResult<boolean>, { path: string }>(IDE_CHANNELS.deleteFile),
  createDir: bridge.buildProvider<IdeFileResult<boolean>, { path: string }>(IDE_CHANNELS.createDir),
  renameFile: bridge.buildProvider<IdeFileResult<boolean>, { oldPath: string; newPath: string }>(
    IDE_CHANNELS.renameFile
  ),
  rulesLoad: bridge.buildProvider<IdeFileResult<string[]>, LoadRulesRequest>(IDE_CHANNELS.rulesLoad),
  kgBuild: bridge.buildProvider<UnderstandResult<KnowledgeGraph>, KnowledgeBuildRequest>(IDE_CHANNELS.kgBuild),
  kgStatus: bridge.buildProvider<UnderstandResult<KnowledgeBuildStatus>, KnowledgeStatusRequest>(IDE_CHANNELS.kgStatus),
  kgGet: bridge.buildProvider<UnderstandResult<KnowledgeGraph | null>, KnowledgeGetRequest>(IDE_CHANNELS.kgGet),
  kgEvent: bridge.buildEmitter<KnowledgeEventEnvelope>(IDE_CHANNELS.kgEvent),
  kgWatchStart: bridge.buildProvider<UnderstandResult<boolean>, KnowledgeWatchStartRequest>(IDE_CHANNELS.kgWatchStart),
  kgWatchStop: bridge.buildProvider<UnderstandResult<boolean>, KnowledgeWatchStopRequest>(IDE_CHANNELS.kgWatchStop),
  kgChanged: bridge.buildEmitter<KnowledgeChangedEnvelope>(IDE_CHANNELS.kgChanged),
  kgDiff: bridge.buildProvider<UnderstandResult<GraphDiff | null>, KnowledgeDiffRequest>(IDE_CHANNELS.kgDiff),
  kgContext: bridge.buildProvider<UnderstandResult<ContextPack | null>, KnowledgeContextRequest>(
    IDE_CHANNELS.kgContext
  ),
  kgRefreshFile: bridge.buildProvider<UnderstandResult<KnowledgeNode | null>, KnowledgeRefreshFileRequest>(
    IDE_CHANNELS.kgRefreshFile
  ),
  qtStart: bridge.buildProvider<UnderstandResult<boolean>, QtStartRequest>(IDE_CHANNELS.qtStart),
  qtStop: bridge.buildProvider<UnderstandResult<QtStopResponse>, void>(IDE_CHANNELS.qtStop),
  qtEvent: bridge.buildEmitter<QtEventEnvelope>(IDE_CHANNELS.qtEvent),
  qtAssetsList: bridge.buildProvider<UnderstandResult<QuickTestAssetState>, { rootPath: string }>(
    IDE_CHANNELS.qtAssetsList
  ),
  qtAssetsArchiveRun: bridge.buildProvider<UnderstandResult<StoredQuickTestRun>, ArchiveRunRequest>(
    IDE_CHANNELS.qtAssetsArchiveRun
  ),
  qtAssetsSaveScenario: bridge.buildProvider<UnderstandResult<ReplayScenario>, SaveScenarioRequest>(
    IDE_CHANNELS.qtAssetsSaveScenario
  ),
  qtAssetsReplay: bridge.buildProvider<UnderstandResult<ReplayRunResult>, ReplayScenarioRequest>(
    IDE_CHANNELS.qtAssetsReplay
  ),
  qtAssetsCompareRuns: bridge.buildProvider<UnderstandResult<QuickTestRunDiff>, CompareRunsRequest>(
    IDE_CHANNELS.qtAssetsCompareRuns
  ),
  qtAssetsSaveBaseline: bridge.buildProvider<UnderstandResult<VisualBaseline>, SaveBaselineRequest>(
    IDE_CHANNELS.qtAssetsSaveBaseline
  ),
  qtAssetsCompareVisual: bridge.buildProvider<UnderstandResult<VisualComparisonResult>, CompareVisualRequest>(
    IDE_CHANNELS.qtAssetsCompareVisual
  ),
  qtAssetsRemove: bridge.buildProvider<UnderstandResult<boolean>, RemoveAssetRequest>(IDE_CHANNELS.qtAssetsRemove),
  qtInsightsObservability: bridge.buildProvider<UnderstandResult<ObservabilityResult>, ObservabilityRequest>(
    IDE_CHANNELS.qtInsightsObservability
  ),
  qtInsightsReliability: bridge.buildProvider<UnderstandResult<ReliabilityResult>, ReliabilityRequest>(
    IDE_CHANNELS.qtInsightsReliability
  ),
  qtInsightsEnvironment: bridge.buildProvider<UnderstandResult<EnvironmentSnapshot>, EnvironmentRequest>(
    IDE_CHANNELS.qtInsightsEnvironment
  ),
  qtInsightsRepeatReplay: bridge.buildProvider<UnderstandResult<RepeatReplayResult>, RepeatReplayRequest>(
    IDE_CHANNELS.qtInsightsRepeatReplay
  ),
  qtInsightsListMocks: bridge.buildProvider<UnderstandResult<MockRuleState>, ListMocksRequest>(
    IDE_CHANNELS.qtInsightsListMocks
  ),
  qtInsightsSaveMock: bridge.buildProvider<UnderstandResult<ApiMockRule>, SaveMockRequest>(
    IDE_CHANNELS.qtInsightsSaveMock
  ),
  qtInsightsRemoveMock: bridge.buildProvider<UnderstandResult<boolean>, RemoveMockRequest>(
    IDE_CHANNELS.qtInsightsRemoveMock
  ),
  qtInsightsExportReport: bridge.buildProvider<UnderstandResult<ExportReportResult>, ExportReportRequest>(
    IDE_CHANNELS.qtInsightsExportReport
  ),
  qtInsightsPreviewCleanup: bridge.buildProvider<UnderstandResult<RetentionCleanupPlan>, RetentionRequest>(
    IDE_CHANNELS.qtInsightsPreviewCleanup
  ),
  qtInsightsApplyCleanup: bridge.buildProvider<UnderstandResult<RetentionCleanupPlan>, ApplyRetentionRequest>(
    IDE_CHANNELS.qtInsightsApplyCleanup
  ),
  qtInsightsEditScenario: bridge.buildProvider<UnderstandResult<EditScenarioResult>, EditScenarioRequest>(
    IDE_CHANNELS.qtInsightsEditScenario
  ),
  inspectPick: bridge.buildProvider<UnderstandResult<LocatedElement | null>, InspectPickRequest>(
    IDE_CHANNELS.inspectPick
  ),
  inspectCancel: bridge.buildProvider<UnderstandResult<boolean>, InspectPickRequest>(IDE_CHANNELS.inspectCancel),
  inspectScreenshot: bridge.buildProvider<UnderstandResult<InspectScreenshotResult | null>, InspectScreenshotRequest>(
    IDE_CHANNELS.inspectScreenshot
  ),
  inspectVideoStart: bridge.buildProvider<UnderstandResult<InspectVideoResult>, InspectPickRequest>(
    IDE_CHANNELS.inspectVideoStart
  ),
  inspectVideoStop: bridge.buildProvider<UnderstandResult<InspectVideoResult>, InspectPickRequest>(
    IDE_CHANNELS.inspectVideoStop
  ),
  inspectAudit: bridge.buildProvider<UnderstandResult<UiAuditReport>, InspectPickRequest>(IDE_CHANNELS.inspectAudit),
  qrPlan: bridge.buildProvider<RunTargetResult<RunPlanResponse>, RunPlanRequest>(IDE_CHANNELS.qrPlan),
  qrSave: bridge.buildProvider<RunTargetResult<RepoRunConfigs>, RunSaveRequest>(IDE_CHANNELS.qrSave),
  qrClear: bridge.buildProvider<RunTargetResult<RepoRunConfigs>, RunClearRequest>(IDE_CHANNELS.qrClear),
  qrProbe: bridge.buildProvider<RunTargetResult<RunProbeResponse>, RunProbeRequest>(IDE_CHANNELS.qrProbe),
  specStatus: bridge.buildProvider<SpecResult<SpecLifecycleStatus>, SpecStatusRequest>(IDE_CHANNELS.specStatus),
  specInit: bridge.buildProvider<SpecResult<SpecLifecycleStatus>, SpecInitRequest>(IDE_CHANNELS.specInit),
  specRead: bridge.buildProvider<SpecResult<string>, SpecReadRequest>(IDE_CHANNELS.specRead),
  specWrite: bridge.buildProvider<SpecResult<SpecLifecycleStatus>, SpecWriteRequest>(IDE_CHANNELS.specWrite),
  specList: bridge.buildProvider<SpecResult<SpecListEntry[]>, SpecStatusRequest>(IDE_CHANNELS.specList),
  specSetActive: bridge.buildProvider<SpecResult<SpecLifecycleStatus>, SpecSetActiveRequest>(
    IDE_CHANNELS.specSetActive
  ),
  specAdvancePhase: bridge.buildProvider<SpecResult<SpecLifecycleStatus>, SpecAdvancePhaseRequest>(
    IDE_CHANNELS.specAdvancePhase
  ),
  specTaskList: bridge.buildProvider<SpecResult<SpecTaskRunbook>, SpecTaskListRequest>(IDE_CHANNELS.specTaskList),
  specTaskClaim: bridge.buildProvider<SpecResult<SpecTaskRunbook>, SpecTaskClaimRequest>(IDE_CHANNELS.specTaskClaim),
  specTaskUpdate: bridge.buildProvider<SpecResult<SpecTaskRunbook>, SpecTaskUpdateRequest>(IDE_CHANNELS.specTaskUpdate),
  specAnalyze: bridge.buildProvider<SpecResult<SpecAnalysis>, SpecAnalyzeRequest>(IDE_CHANNELS.specAnalyze),
  gitStatus: bridge.buildProvider<IdeGitResult<GitChange[]>, GitStatusRequest>(IDE_CHANNELS.gitStatus),
  gitDiff: bridge.buildProvider<IdeGitResult<string>, GitDiffRequest>(IDE_CHANNELS.gitDiff),
  gitRevertFile: bridge.buildProvider<IdeGitResult<boolean>, GitRevertRequest>(IDE_CHANNELS.gitRevertFile),
  mtuiPolicyCheck: bridge.buildProvider<MtuiPolicyResult<MtuiPolicyCheckResult>, MtuiPolicyCheckRequest>(
    IDE_CHANNELS.mtuiPolicyCheck
  ),
  grep: bridge.buildProvider<IdeSearchResult<IdeGrepMatch[]>, GrepRequest>(IDE_CHANNELS.grep),
  replaceFile: bridge.buildProvider<IdeSearchResult<number>, ReplaceFileRequest>(IDE_CHANNELS.replaceFile),
  lintFile: bridge.buildProvider<IdeLintResult, LintFileRequest>(IDE_CHANNELS.lintFile),
  findDefinition: bridge.buildProvider<IdeNavResult, NavRequest>(IDE_CHANNELS.findDefinition),
  findReferences: bridge.buildProvider<IdeNavResult, NavRequest>(IDE_CHANNELS.findReferences),
  analyzeLanguages: bridge.buildProvider<IdeLangResult, AnalyzeLanguagesRequest>(IDE_CHANNELS.analyzeLanguages),
  inlineComplete: bridge.buildProvider<IdeCompletionResult, InlineCompleteRequest>(IDE_CHANNELS.inlineComplete),
  memorySnapshot: bridge.buildProvider<IdeMemoryResult<SuperMemorySnapshot>, IdeMemoryRequest>(
    IDE_CHANNELS.memorySnapshot
  ),
  memoryClear: bridge.buildProvider<IdeMemoryResult<boolean>, IdeMemoryRequest>(IDE_CHANNELS.memoryClear),
  memoryRemember: bridge.buildProvider<IdeMemoryResult<RememberResult>, IdeMemoryRememberRequest>(
    IDE_CHANNELS.memoryRemember
  ),
  repoSecretList: bridge.buildProvider<IdeMemoryResult<RepoSecretContext[]>, RepoSecretListRequest>(
    IDE_CHANNELS.repoSecretList
  ),
  repoSecretSave: bridge.buildProvider<IdeMemoryResult<RepoSecretContext>, RepoSecretSaveRequest>(
    IDE_CHANNELS.repoSecretSave
  ),
  repoSecretDeclare: bridge.buildProvider<IdeMemoryResult<RepoSecretContext>, RepoSecretDeclareRequest>(
    IDE_CHANNELS.repoSecretDeclare
  ),
  repoSecretRemove: bridge.buildProvider<IdeMemoryResult<boolean>, RepoSecretRemoveRequest>(
    IDE_CHANNELS.repoSecretRemove
  ),
  repoSecretReveal: bridge.buildProvider<IdeMemoryResult<string>, RepoSecretRevealRequest>(
    IDE_CHANNELS.repoSecretReveal
  ),
  repoSecretRenderMarkers: bridge.buildProvider<
    IdeMemoryResult<RepoSecretMarkerRender>,
    RepoSecretRenderMarkersRequest
  >(IDE_CHANNELS.repoSecretRenderMarkers),
  runCommand: bridge.buildProvider<IdeCommandResult<CommandResult>, RunCommandRequest>(IDE_CHANNELS.runCommand),
};

/** Error thrown when an IDE IPC call does not reply within its budget. */
export class IdeBridgeTimeoutError extends Error {
  constructor(channel: string, timeoutMs: number) {
    super(`[IdeClient] No reply on "${channel}" after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'IdeBridgeTimeoutError';
  }
}

/** Race an `invoke` against a timeout so an unregistered channel rejects fast. */
const invokeWithTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new IdeBridgeTimeoutError(channel, timeoutMs));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/** Timeout-guarded IDE invokers for the renderer. */
export const ideClient = {
  scanRepo: (rootPath: string, maxFiles?: number): Promise<IdeScanResult> =>
    invokeWithTimeout(IDE_CHANNELS.scanRepo, () => channels.scanRepo.invoke({ rootPath, maxFiles }), SCAN_TIMEOUT_MS),
  wikiPlan: (request: WikiPlanRequest): Promise<IdeWikiResult<WikiPlan>> =>
    invokeWithTimeout(IDE_CHANNELS.wikiPlan, () => channels.wikiPlan.invoke(request), WIKI_PLAN_TIMEOUT_MS),
  wikiSection: (request: WikiSectionRequest): Promise<IdeWikiResult<string>> =>
    invokeWithTimeout(IDE_CHANNELS.wikiSection, () => channels.wikiSection.invoke(request), WIKI_SECTION_TIMEOUT_MS),
  /**
   * Build a durable, verified wiki for a repo: scan → verify the docs against the
   * real code (auto-fixing stale paths/commands) → plan → author each section
   * with a self-evaluate/improve loop → persist. Long-running (many model calls);
   * subscribe to {@link ideClient.onWikiProgress} for live phase updates.
   */
  wikiBuild: (request: WikiBuildRequest): Promise<IdeWikiResult<PersistedWiki>> =>
    invokeWithTimeout(IDE_CHANNELS.wikiBuild, () => channels.wikiBuild.invoke(request), WIKI_BUILD_TIMEOUT_MS),
  /** Cancel the active durable-wiki build for a repo, if one exists. */
  wikiCancel: (rootPath: string): Promise<IdeWikiResult<boolean>> =>
    invokeWithTimeout(IDE_CHANNELS.wikiCancel, () => channels.wikiCancel.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Load the previously-built, persisted wiki for a repo (or null when absent). */
  wikiLoad: (rootPath: string): Promise<IdeWikiResult<PersistedWiki | null>> =>
    invokeWithTimeout(IDE_CHANNELS.wikiLoad, () => channels.wikiLoad.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Subscribe to live wiki-build phase progress (Main → renderer). Returns an unsubscribe fn. */
  onWikiProgress: (listener: (progress: WikiBuildProgress) => void): (() => void) => channels.wikiProgress.on(listener),
  listDir: (
    dir: string,
    opts?: { glob?: string; recursive?: boolean; maxResults?: number }
  ): Promise<IdeFileResult<IdeDirEntry[]>> =>
    invokeWithTimeout(IDE_CHANNELS.listDir, () => channels.listDir.invoke({ dir, ...opts }), FILE_OP_TIMEOUT_MS),
  readFile: (filePathOrReq: string | ReadFileRequest): Promise<IdeFileResult<ReadFileData>> => {
    const req: ReadFileRequest = typeof filePathOrReq === 'string' ? { path: filePathOrReq } : filePathOrReq;
    return invokeWithTimeout(IDE_CHANNELS.readFile, () => channels.readFile.invoke(req), FILE_OP_TIMEOUT_MS);
  },
  readFileBase64: (filePath: string): Promise<IdeFileResult<string>> =>
    invokeWithTimeout(
      IDE_CHANNELS.readFileBase64,
      () => channels.readFileBase64.invoke({ path: filePath }),
      FILE_OP_TIMEOUT_MS
    ),
  writeFile: (filePath: string, data: string): Promise<IdeFileResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.writeFile,
      () => channels.writeFile.invoke({ path: filePath, data }),
      FILE_OP_TIMEOUT_MS
    ),
  writeFileBase64: (filePath: string, dataBase64: string): Promise<IdeFileResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.writeFileBase64,
      () => channels.writeFileBase64.invoke({ path: filePath, dataBase64 }),
      FILE_OP_TIMEOUT_MS
    ),
  fileWatchStart: (rootPath: string): Promise<IdeFileResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.fileWatchStart,
      () => channels.fileWatchStart.invoke({ rootPath }),
      FILE_OP_TIMEOUT_MS
    ),
  fileWatchStop: (rootPath: string): Promise<IdeFileResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.fileWatchStop,
      () => channels.fileWatchStop.invoke({ rootPath }),
      FILE_OP_TIMEOUT_MS
    ),
  onFileChanged: (listener: (event: IdeFileChangeEvent) => void): (() => void) =>
    channels.fileChanged.on((envelope) => listener(envelope.event)),
  /** Delete a file at the given absolute path. Gracefully degrades if the channel is not registered. */
  deleteFile: (filePath: string): Promise<IdeFileResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.deleteFile,
      () => channels.deleteFile.invoke({ path: filePath }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Create a directory (and any missing parents) at the given absolute path. */
  createDir: (dirPath: string): Promise<IdeFileResult<boolean>> =>
    invokeWithTimeout(IDE_CHANNELS.createDir, () => channels.createDir.invoke({ path: dirPath }), FILE_OP_TIMEOUT_MS),
  /** Load project rules from `.aionrules` / `AGENTS.md` / `.cursorrules` in the repo. */
  rulesLoad: (rootPath: string): Promise<IdeFileResult<string[]>> =>
    invokeWithTimeout(IDE_CHANNELS.rulesLoad, () => channels.rulesLoad.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Rename / move a file from oldPath to newPath. */
  renameFile: (oldPath: string, newPath: string): Promise<IdeFileResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.renameFile,
      () => channels.renameFile.invoke({ oldPath, newPath }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Build the Understand-Anything knowledge graph for a repo (long-running). */
  kgBuild: (
    rootPath: string,
    model: string,
    language?: string,
    forceFresh?: boolean
  ): Promise<UnderstandResult<KnowledgeGraph>> =>
    invokeWithTimeout(
      IDE_CHANNELS.kgBuild,
      () => channels.kgBuild.invoke({ rootPath, model, language, forceFresh }),
      KG_BUILD_TIMEOUT_MS
    ),
  /** Get an active background build status so the UI can reattach after reload/navigation. */
  kgStatus: (rootPath: string): Promise<UnderstandResult<KnowledgeBuildStatus>> =>
    invokeWithTimeout(IDE_CHANNELS.kgStatus, () => channels.kgStatus.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Load a previously-built knowledge graph for a repo (or null). */
  kgGet: (rootPath: string): Promise<UnderstandResult<KnowledgeGraph | null>> =>
    invokeWithTimeout(IDE_CHANNELS.kgGet, () => channels.kgGet.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Subscribe to knowledge-graph build phase events. Returns an unsubscribe fn. */
  onKgEvent: (
    listener: (event: { phase: KnowledgeBuildPhase; detail?: string; rootPath?: string }) => void
  ): (() => void) => channels.kgEvent.on((envelope) => listener(envelope.event)),
  /** Start watching a repo for live changes (Live mode; no automatic semantic build). */
  kgWatchStart: (rootPath: string, model?: string | null, language?: string): Promise<UnderstandResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.kgWatchStart,
      () => channels.kgWatchStart.invoke({ rootPath, model, language }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Stop watching a repo for live changes. */
  kgWatchStop: (rootPath: string): Promise<UnderstandResult<boolean>> =>
    invokeWithTimeout(IDE_CHANNELS.kgWatchStop, () => channels.kgWatchStop.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Subscribe to live repo-change batches (Live mode). Returns an unsubscribe fn. */
  onKgChanged: (listener: (event: RepoChangeEvent) => void): (() => void) =>
    channels.kgChanged.on((envelope) => listener(envelope.event)),
  /** Diff the two most recent graph snapshots (time dimension / regression hint). */
  kgDiff: (rootPath: string): Promise<UnderstandResult<GraphDiff | null>> =>
    invokeWithTimeout(IDE_CHANNELS.kgDiff, () => channels.kgDiff.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Build a focused context pack for an agent request (Context Builder). */
  kgContext: (
    rootPath: string,
    request: string,
    rules?: string[],
    includeDiff?: boolean
  ): Promise<UnderstandResult<ContextPack | null>> =>
    invokeWithTimeout(
      IDE_CHANNELS.kgContext,
      () => channels.kgContext.invoke({ rootPath, request, rules, includeDiff }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Deterministically refresh ONE file's structural node in the persisted graph (no model). */
  kgRefreshFile: (
    rootPath: string,
    relPath: string,
    content: string,
    opts?: { summarize?: boolean; model?: string }
  ): Promise<UnderstandResult<KnowledgeNode | null>> =>
    invokeWithTimeout(
      IDE_CHANNELS.kgRefreshFile,
      () =>
        channels.kgRefreshFile.invoke({ rootPath, relPath, content, summarize: opts?.summarize, model: opts?.model }),
      opts?.summarize ? WIKI_SECTION_TIMEOUT_MS : FILE_OP_TIMEOUT_MS
    ),
  /**
   * Start Quick Test recording. For the `web` platform this attaches CDP to the
   * active browser tab; for `android`/`windows` it attaches to the platform's
   * native log stream (adb logcat / process stdio). `target` is the android
   * device serial or the Windows `.exe` path (ignored for web).
   */
  qtStart: (
    rootPath: string,
    platform: QtTracePlatform = 'web',
    target?: string,
    expectedText?: string,
    tabId?: string
  ): Promise<UnderstandResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtStart,
      () => channels.qtStart.invoke({ rootPath, platform, target, expectedText, tabId }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Stop Quick Test recording and return the trace + context pack. */
  qtStop: (): Promise<UnderstandResult<QtStopResponse>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtStop,
      () => channels.qtStop.invoke(undefined as unknown as void),
      FILE_OP_TIMEOUT_MS
    ),
  /** Subscribe to live Quick Test trace events. Returns an unsubscribe fn. */
  onQtEvent: (listener: (event: QtEventEnvelope['event']) => void): (() => void) =>
    channels.qtEvent.on((envelope) => listener(envelope.event)),
  qtAssetsList: (rootPath: string): Promise<UnderstandResult<QuickTestAssetState>> =>
    invokeWithTimeout(IDE_CHANNELS.qtAssetsList, () => channels.qtAssetsList.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  qtAssetsArchiveRun: (request: ArchiveRunRequest): Promise<UnderstandResult<StoredQuickTestRun>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtAssetsArchiveRun,
      () => channels.qtAssetsArchiveRun.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtAssetsSaveScenario: (request: SaveScenarioRequest): Promise<UnderstandResult<ReplayScenario>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtAssetsSaveScenario,
      () => channels.qtAssetsSaveScenario.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtAssetsReplay: (request: ReplayScenarioRequest): Promise<UnderstandResult<ReplayRunResult>> =>
    invokeWithTimeout(IDE_CHANNELS.qtAssetsReplay, () => channels.qtAssetsReplay.invoke(request), UI_AUDIT_TIMEOUT_MS),
  qtAssetsCompareRuns: (request: CompareRunsRequest): Promise<UnderstandResult<QuickTestRunDiff>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtAssetsCompareRuns,
      () => channels.qtAssetsCompareRuns.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtAssetsSaveBaseline: (request: SaveBaselineRequest): Promise<UnderstandResult<VisualBaseline>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtAssetsSaveBaseline,
      () => channels.qtAssetsSaveBaseline.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtAssetsCompareVisual: (request: CompareVisualRequest): Promise<UnderstandResult<VisualComparisonResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtAssetsCompareVisual,
      () => channels.qtAssetsCompareVisual.invoke(request),
      UI_AUDIT_TIMEOUT_MS
    ),
  qtAssetsRemove: (request: RemoveAssetRequest): Promise<UnderstandResult<boolean>> =>
    invokeWithTimeout(IDE_CHANNELS.qtAssetsRemove, () => channels.qtAssetsRemove.invoke(request), FILE_OP_TIMEOUT_MS),
  qtInsightsObservability: (request: ObservabilityRequest): Promise<UnderstandResult<ObservabilityResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsObservability,
      () => channels.qtInsightsObservability.invoke(request),
      UI_AUDIT_TIMEOUT_MS
    ),
  qtInsightsReliability: (request: ReliabilityRequest): Promise<UnderstandResult<ReliabilityResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsReliability,
      () => channels.qtInsightsReliability.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtInsightsEnvironment: (request: EnvironmentRequest): Promise<UnderstandResult<EnvironmentSnapshot>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsEnvironment,
      () => channels.qtInsightsEnvironment.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtInsightsRepeatReplay: (request: RepeatReplayRequest): Promise<UnderstandResult<RepeatReplayResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsRepeatReplay,
      () => channels.qtInsightsRepeatReplay.invoke(request),
      5 * 60_000
    ),
  qtInsightsListMocks: (request: ListMocksRequest): Promise<UnderstandResult<MockRuleState>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsListMocks,
      () => channels.qtInsightsListMocks.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtInsightsSaveMock: (request: SaveMockRequest): Promise<UnderstandResult<ApiMockRule>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsSaveMock,
      () => channels.qtInsightsSaveMock.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtInsightsRemoveMock: (request: RemoveMockRequest): Promise<UnderstandResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsRemoveMock,
      () => channels.qtInsightsRemoveMock.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtInsightsExportReport: (request: ExportReportRequest): Promise<UnderstandResult<ExportReportResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsExportReport,
      () => channels.qtInsightsExportReport.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtInsightsPreviewCleanup: (request: RetentionRequest): Promise<UnderstandResult<RetentionCleanupPlan>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsPreviewCleanup,
      () => channels.qtInsightsPreviewCleanup.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtInsightsApplyCleanup: (request: ApplyRetentionRequest): Promise<UnderstandResult<RetentionCleanupPlan>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsApplyCleanup,
      () => channels.qtInsightsApplyCleanup.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  qtInsightsEditScenario: (request: EditScenarioRequest): Promise<UnderstandResult<EditScenarioResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.qtInsightsEditScenario,
      () => channels.qtInsightsEditScenario.invoke(request),
      FILE_OP_TIMEOUT_MS
    ),
  /**
   * Element inspector (additive, CDP-free visual picker): arm the page-side
   * picker and resolve with the clicked element mapped to its component +
   * file:line, or null when the user cancelled (Escape / toggled off). The long
   * timeout reflects that this waits for a human click.
   */
  inspectPick: (rootPath: string, tabId?: string): Promise<UnderstandResult<LocatedElement | null>> =>
    invokeWithTimeout(
      IDE_CHANNELS.inspectPick,
      () => channels.inspectPick.invoke({ rootPath, tabId }),
      INSPECT_TIMEOUT_MS
    ),
  /** Cancel an in-flight element pick (resolves the awaiting pick to null). */
  inspectCancel: (rootPath: string, tabId?: string): Promise<UnderstandResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.inspectCancel,
      () => channels.inspectCancel.invoke({ rootPath, tabId }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Capture the inspected tab as a PNG saved into the repo (for a vision agent). */
  inspectScreenshot: (
    rootPath: string,
    mode: InspectScreenshotRequest['mode'],
    tabId?: string
  ): Promise<UnderstandResult<InspectScreenshotResult | null>> =>
    invokeWithTimeout(
      IDE_CHANNELS.inspectScreenshot,
      () => channels.inspectScreenshot.invoke({ rootPath, mode, tabId }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Start recording the embedded web tab to an MP4 in the repo. */
  inspectVideoStart: (rootPath: string, tabId: string): Promise<UnderstandResult<InspectVideoResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.inspectVideoStart,
      () => channels.inspectVideoStart.invoke({ rootPath, tabId }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Stop and finalise the active embedded-tab recording. */
  inspectVideoStop: (rootPath: string, tabId: string): Promise<UnderstandResult<InspectVideoResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.inspectVideoStop,
      () => channels.inspectVideoStop.invoke({ rootPath, tabId }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Run deterministic UI quality rules against the current embedded page. */
  inspectAudit: (rootPath: string, tabId: string): Promise<UnderstandResult<UiAuditReport>> =>
    invokeWithTimeout(
      IDE_CHANNELS.inspectAudit,
      () => channels.inspectAudit.invoke({ rootPath, tabId }),
      UI_AUDIT_TIMEOUT_MS
    ),
  /**
   * Quick-Run: derive the mechanical run plan from the repo's persisted run data
   * (wiki/Understand runbook) + every package.json, plus any saved recipes. No
   * model call — the AI only built the wiki earlier.
   */
  qrPlan: (rootPath: string): Promise<RunTargetResult<RunPlanResponse>> =>
    invokeWithTimeout(IDE_CHANNELS.qrPlan, () => channels.qrPlan.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Quick-Run: persist a run recipe that succeeded (so later runs need no AI). */
  qrSave: (rootPath: string, config: RunSaveRequest['config']): Promise<RunTargetResult<RepoRunConfigs>> =>
    invokeWithTimeout(IDE_CHANNELS.qrSave, () => channels.qrSave.invoke({ rootPath, config }), FILE_OP_TIMEOUT_MS),
  /** Quick-Run: forget the saved recipe for one platform. */
  qrClear: (rootPath: string, platform: RunPlatform): Promise<RunTargetResult<RepoRunConfigs>> =>
    invokeWithTimeout(IDE_CHANNELS.qrClear, () => channels.qrClear.invoke({ rootPath, platform }), FILE_OP_TIMEOUT_MS),
  /** Quick-Run: poll a dev URL once (to know when the terminal-launched server is up). */
  qrProbe: (url: string): Promise<RunTargetResult<RunProbeResponse>> =>
    invokeWithTimeout(IDE_CHANNELS.qrProbe, () => channels.qrProbe.invoke({ url }), FILE_OP_TIMEOUT_MS),
  /** Get the latest Kiro-style spec directory status for this repo. */
  specStatus: (rootPath: string): Promise<SpecResult<SpecLifecycleStatus>> =>
    invokeWithTimeout(IDE_CHANNELS.specStatus, () => channels.specStatus.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Create a Kiro-style spec directory with template files. */
  specInit: (rootPath: string, title: string): Promise<SpecResult<SpecLifecycleStatus>> =>
    invokeWithTimeout(IDE_CHANNELS.specInit, () => channels.specInit.invoke({ rootPath, title }), FILE_OP_TIMEOUT_MS),
  /** Read one file from a spec directory. */
  specRead: (rootPath: string, slug: string, file: SpecFileName): Promise<SpecResult<string>> =>
    invokeWithTimeout(
      IDE_CHANNELS.specRead,
      () => channels.specRead.invoke({ rootPath, slug, file }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Write one file in a spec directory. */
  specWrite: (
    rootPath: string,
    slug: string,
    file: SpecFileName,
    content: string
  ): Promise<SpecResult<SpecLifecycleStatus>> =>
    invokeWithTimeout(
      IDE_CHANNELS.specWrite,
      () => channels.specWrite.invoke({ rootPath, slug, file, content }),
      FILE_OP_TIMEOUT_MS
    ),
  /** List all Kiro-style spec directories for execute-plan dropdowns. */
  specList: (rootPath: string): Promise<SpecResult<SpecListEntry[]>> =>
    invokeWithTimeout(IDE_CHANNELS.specList, () => channels.specList.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Set (or clear, with slug=null) the workspace's active spec. */
  specSetActive: (rootPath: string, slug: string | null): Promise<SpecResult<SpecLifecycleStatus>> =>
    invokeWithTimeout(
      IDE_CHANNELS.specSetActive,
      () => channels.specSetActive.invoke({ rootPath, slug }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Approve the current phase gate of the active/named spec and advance it. */
  specAdvancePhase: (
    rootPath: string,
    gate: SpecApprovalGate,
    slug?: string
  ): Promise<SpecResult<SpecLifecycleStatus>> =>
    invokeWithTimeout(
      IDE_CHANNELS.specAdvancePhase,
      () => channels.specAdvancePhase.invoke({ rootPath, gate, slug }),
      FILE_OP_TIMEOUT_MS
    ),
  /** List the authoritative task backend for the latest or requested spec. */
  specTaskList: (rootPath: string, slug?: string): Promise<SpecResult<SpecTaskRunbook>> =>
    invokeWithTimeout(
      IDE_CHANNELS.specTaskList,
      () => channels.specTaskList.invoke({ rootPath, slug }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Claim the active or next pending task for an agent. */
  specTaskClaim: (
    rootPath: string,
    slug?: string,
    taskId?: string,
    agentId?: string
  ): Promise<SpecResult<SpecTaskRunbook>> =>
    invokeWithTimeout(
      IDE_CHANNELS.specTaskClaim,
      () => channels.specTaskClaim.invoke({ rootPath, slug, taskId, agentId }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Update one backend task and optionally append verification evidence. */
  specTaskUpdate: (request: SpecTaskUpdateRequest): Promise<SpecResult<SpecTaskRunbook>> =>
    invokeWithTimeout(IDE_CHANNELS.specTaskUpdate, () => channels.specTaskUpdate.invoke(request), FILE_OP_TIMEOUT_MS),
  /** Run the full pure spec analysis (EARS + traceability + phase gates). */
  specAnalyze: (rootPath: string, slug?: string): Promise<SpecResult<SpecAnalysis>> =>
    invokeWithTimeout(
      IDE_CHANNELS.specAnalyze,
      () => channels.specAnalyze.invoke({ rootPath, slug }),
      FILE_OP_TIMEOUT_MS
    ),
  /** List the working-tree changes of a repo vs HEAD (for the diff-review banner). */
  gitStatus: (rootPath: string): Promise<IdeGitResult<GitChange[]>> =>
    invokeWithTimeout(IDE_CHANNELS.gitStatus, () => channels.gitStatus.invoke({ rootPath }), FILE_OP_TIMEOUT_MS),
  /** Get the unified diff text of a single file vs HEAD (or synthetic add for untracked). */
  gitDiff: (rootPath: string, relPath: string): Promise<IdeGitResult<string>> =>
    invokeWithTimeout(IDE_CHANNELS.gitDiff, () => channels.gitDiff.invoke({ rootPath, relPath }), FILE_OP_TIMEOUT_MS),
  /** Revert a single file's working-tree changes (`git checkout -- <file>`). */
  gitRevertFile: (rootPath: string, relPath: string): Promise<IdeGitResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.gitRevertFile,
      () => channels.gitRevertFile.invoke({ rootPath, relPath }),
      FILE_OP_TIMEOUT_MS
    ),
  mtuiPolicyCheck: (rootPath: string, changedPaths: string[]): Promise<MtuiPolicyResult<MtuiPolicyCheckResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.mtuiPolicyCheck,
      () => channels.mtuiPolicyCheck.invoke({ rootPath, changedPaths }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Project-wide text search over the open folder (Node fs walk + grep). */
  grep: (
    rootPath: string,
    query: string,
    opts?: { caseSensitive?: boolean; regex?: boolean; wholeWord?: boolean }
  ): Promise<IdeSearchResult<IdeGrepMatch[]>> =>
    invokeWithTimeout(
      IDE_CHANNELS.grep,
      () =>
        channels.grep.invoke({
          rootPath,
          query,
          caseSensitive: opts?.caseSensitive,
          regex: opts?.regex,
          wholeWord: opts?.wholeWord,
        }),
      SCAN_TIMEOUT_MS
    ),
  /** Replace all matches in ONE file (via the MTUI write gateway). Returns the count. */
  replaceFile: (req: ReplaceFileRequest): Promise<IdeSearchResult<number>> =>
    invokeWithTimeout(IDE_CHANNELS.replaceFile, () => channels.replaceFile.invoke(req), FILE_OP_TIMEOUT_MS),
  /** Lint ONE file with oxlint and return inline diagnostics (Monaco markers). */
  lintFile: (filePath: string, rootPath: string): Promise<IdeLintResult> =>
    invokeWithTimeout(IDE_CHANNELS.lintFile, () => channels.lintFile.invoke({ filePath, rootPath }), SCAN_TIMEOUT_MS),
  /** Heuristic go-to-definition: declaration sites of a symbol across the repo. */
  findDefinition: (rootPath: string, symbol: string): Promise<IdeNavResult> =>
    invokeWithTimeout(
      IDE_CHANNELS.findDefinition,
      () => channels.findDefinition.invoke({ rootPath, symbol }),
      SCAN_TIMEOUT_MS
    ),
  /** Heuristic find-references: all occurrences of a symbol across the repo. */
  findReferences: (rootPath: string, symbol: string): Promise<IdeNavResult> =>
    invokeWithTimeout(
      IDE_CHANNELS.findReferences,
      () => channels.findReferences.invoke({ rootPath, symbol }),
      SCAN_TIMEOUT_MS
    ),
  /** Detect repo languages + recommended editor engines via `mtui analyze type`. */
  analyzeLanguages: (rootPath: string): Promise<IdeLangResult> =>
    invokeWithTimeout(
      IDE_CHANNELS.analyzeLanguages,
      () => channels.analyzeLanguages.invoke({ rootPath }),
      SCAN_TIMEOUT_MS
    ),
  /** Inline (Tab) completion: model-generated code to insert at the cursor. */
  inlineComplete: (req: InlineCompleteRequest): Promise<IdeCompletionResult> =>
    invokeWithTimeout(
      IDE_CHANNELS.inlineComplete,
      () => channels.inlineComplete.invoke(req),
      INLINE_COMPLETE_TIMEOUT_MS
    ),
  /** Read the ephemeral session super-memory snapshot (notes + token usage + secret keys). */
  memorySnapshot: (sessionId: string): Promise<IdeMemoryResult<SuperMemorySnapshot>> =>
    invokeWithTimeout(
      IDE_CHANNELS.memorySnapshot,
      () => channels.memorySnapshot.invoke({ sessionId }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Drop a whole session's super-memory — called when an IDE chat tab is closed. */
  memoryClear: (sessionId: string): Promise<IdeMemoryResult<boolean>> =>
    invokeWithTimeout(IDE_CHANNELS.memoryClear, () => channels.memoryClear.invoke({ sessionId }), FILE_OP_TIMEOUT_MS),
  /** Manually jot a note into a session's super-memory from the memory drawer. */
  memoryRemember: (
    sessionId: string,
    text: string,
    opts?: { kind?: IdeMemoryRecordableKind; pinned?: boolean }
  ): Promise<IdeMemoryResult<RememberResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.memoryRemember,
      () => channels.memoryRemember.invoke({ sessionId, text, kind: opts?.kind, pinned: opts?.pinned }),
      FILE_OP_TIMEOUT_MS
    ),
  /** List metadata-only repository Secret Context entries. */
  repoSecretList: (repository: string): Promise<IdeMemoryResult<RepoSecretContext[]>> =>
    invokeWithTimeout(
      IDE_CHANNELS.repoSecretList,
      () => channels.repoSecretList.invoke({ repository }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Store a value in the OS-encrypted repository vault; response is metadata only. */
  repoSecretSave: (
    repository: string,
    alias: string,
    description: string,
    value: string
  ): Promise<IdeMemoryResult<RepoSecretContext>> =>
    invokeWithTimeout(
      IDE_CHANNELS.repoSecretSave,
      () => channels.repoSecretSave.invoke({ repository, alias, description, value }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Register a metadata-only alias, used by an agent before the user supplies its value. */
  repoSecretDeclare: (
    repository: string,
    alias: string,
    description: string
  ): Promise<IdeMemoryResult<RepoSecretContext>> =>
    invokeWithTimeout(
      IDE_CHANNELS.repoSecretDeclare,
      () => channels.repoSecretDeclare.invoke({ repository, alias, description }),
      FILE_OP_TIMEOUT_MS
    ),
  repoSecretRemove: (repository: string, alias: string): Promise<IdeMemoryResult<boolean>> =>
    invokeWithTimeout(
      IDE_CHANNELS.repoSecretRemove,
      () => channels.repoSecretRemove.invoke({ repository, alias }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Explicit local-user action; never exposed to the agent/MCP protocol. */
  repoSecretReveal: (repository: string, alias: string): Promise<IdeMemoryResult<string>> =>
    invokeWithTimeout(
      IDE_CHANNELS.repoSecretReveal,
      () => channels.repoSecretReveal.invoke({ repository, alias }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Expands `{{secret:ALIAS}}` only after an explicit local renderer request. */
  repoSecretRenderMarkers: (repository: string, text: string): Promise<IdeMemoryResult<RepoSecretMarkerRender>> =>
    invokeWithTimeout(
      IDE_CHANNELS.repoSecretRenderMarkers,
      () => channels.repoSecretRenderMarkers.invoke({ repository, text }),
      FILE_OP_TIMEOUT_MS
    ),
  /** Run a guarded shell command via the Main-process IDE command bridge. */
  runCommand: (
    rootPath: string,
    command: string,
    opts?: { cwd?: string; timeoutMs?: number }
  ): Promise<IdeCommandResult<CommandResult>> =>
    invokeWithTimeout(
      IDE_CHANNELS.runCommand,
      () => channels.runCommand.invoke({ rootPath, command, cwd: opts?.cwd, timeoutMs: opts?.timeoutMs }),
      opts?.timeoutMs ?? COMMAND_TIMEOUT_MS
    ),
};

export type { IdeScanResult, RepoGraph };
export type { GraphEdge, GraphNode } from '@process/ide/repoGraph';
export type { IdeWikiResult, WikiPlan, WikiSectionRequest, WikiPlanRequest } from '@process/ide/ideWikiBridge';
export type { KeyFile, WikiSectionPlan } from '@process/ide/ideWikiBridge';
export type {
  WikiBuildRequest,
  WikiLoadRequest,
  WikiBuildProgress,
  PersistedWiki,
  PersistedWikiSection,
  PersistedDocReport,
  WikiBootstrapPhase,
} from '@process/ide/wiki/wikiBuildBridge';
export type { IdeDirEntry, IdeFileChangeEvent, IdeFileResult } from '@process/ide/ideFileBridge';
export type { QtStopResponse, QtEventEnvelope } from '@process/ide/quickTestBridge';
export type {
  RuntimeTrace,
  TraceEvent,
  TraceEvidence,
  TracePlatform,
  TraceStackFrame,
} from '@process/ide/quickTestTracer';
export type { UiAuditCategory, UiAuditFinding, UiAuditReport, UiAuditSeverity } from '@process/ide/uiAuditEngine';
export type { QuickTestAssetState, StoredQuickTestRun } from '@process/ide/quickTestAssetBridge';
export type { ReplayRunResult, ReplayScenario } from '@process/ide/quickTestReplay';
export type { QuickTestRunDiff } from '@process/ide/quickTestRunCompare';
export type { VisualBaseline, VisualComparisonResult } from '@process/ide/quickTestVisualRegression';
export type {
  EditScenarioRequest,
  EditScenarioResult,
  EnvironmentSnapshot,
  ExportReportResult,
  MockRuleState,
  ObservabilityResult,
  ReliabilityResult,
  RepeatReplayResult,
  RetentionCleanupPlan,
};
export type { ApiMockRule } from '@process/services/quick-test/observability';
export type {
  RunPlanResponse,
  RunPlanSource,
  RunSaveRequest,
  RunClearRequest,
  RunTargetResult,
} from '@process/ide/runTarget/runTargetBridge';
export type { RepoRunConfigs, SavedRunConfig } from '@process/ide/runTarget/runConfigStore';
export type {
  RunPlan,
  RunCandidate,
  RunPlatform,
  RunService,
  RunServiceKind,
  PlatformSupport,
} from '@process/ide/runTarget/runTargetPlanner';
export type { GitChange, IdeGitResult } from '@process/ide/ideGitBridge';
export type { CommandResult, IdeCommandResult, RunCommandRequest };
export type {
  SpecFileName,
  SpecListEntry,
  SpecLifecycleStatus,
  SpecLifecyclePhase,
  SpecApprovalGate,
  SpecManifest,
  SpecResult,
  SpecTaskCounts,
  SpecTaskRecord,
  SpecTaskRunbook,
  SpecTaskStatus,
} from '@process/ide/specLifecycleBridge';
export type {
  ArchLayer,
  KnowledgeBuildPhase,
  KnowledgeGraph,
  KnowledgeNode,
  KnowledgeEdge,
  GuidedTour,
  UnderstandResult,
  ProjectOverview,
  KnowledgeModule,
  ProjectRunbook,
  ProjectRunCommand,
  KnowledgeDiagram,
  ModuleEdge,
  ExternalDependency,
  SummarySource,
  C4Level,
  RepoChangeEvent,
  ImpactResult,
  GraphDiff,
  ContextPack,
  ContextSlice,
} from '@process/ide/understandTypes';
export type { KnowledgeBuildStatus } from '@process/ide/knowledgeGraphBridge';
export type {
  IdeGrepMatch,
  GrepRequest,
  ReplaceFileRequest,
  IdeSearchResult,
} from '@process/ide/search/ideSearchBridge';
export type { IdeLintResult, LintFileRequest } from '@process/ide/lint/ideLintBridge';
export type { LintDiagnostic, LintSeverity } from '@process/ide/lint/lintParse';
export type { IdeNavResult, NavRequest, NavHit } from '@process/ide/nav/ideNavBridge';
export type {
  IdeLangResult,
  AnalyzeLanguagesRequest,
  LanguageAnalysis,
  LanguageEngineEntry,
} from '@process/ide/lang/ideLangBridge';
export type { IdeCompletionResult, InlineCompleteRequest } from '@process/ide/lang/ideCompletionBridge';
export type {
  IdeMemoryResult,
  IdeMemoryRequest,
  IdeMemoryRememberRequest,
  IdeMemoryRecordableKind,
} from '@process/ide/memory/ideMemoryBridge';
export type {
  SuperMemorySnapshot,
  SuperMemoryItem,
  SuperMemoryKind,
  RememberResult,
} from '@process/ide/memory/sessionMemoryStore';
