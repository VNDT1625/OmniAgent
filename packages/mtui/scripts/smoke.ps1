$ErrorActionPreference = 'Stop'

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
$Binary = Join-Path $RepoRoot 'target\release\mtui.exe'
if (-not (Test-Path $Binary)) {
    $Installed = Join-Path $env:LOCALAPPDATA 'mtui\mtui.exe'
    if (Test-Path $Installed) {
        $Binary = $Installed
    } else {
        throw 'Cannot find mtui.exe. Run cargo build --release or install.ps1 first.'
    }
}

$Root = Join-Path $env:TEMP ('mtui-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $Root | Out-Null
git -C $Root init -q
New-Item -ItemType Directory -Force -Path (Join-Path $Root '.aionui\specs\smoke-plan') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root '.aionui\specs\smoke-plan\plan\temporary') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root '.aionui\understand') | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $Root 'src') | Out-Null
Set-Content -Path (Join-Path $Root 'src\a.ts') -Value 'export const a = 1;' -Encoding UTF8
[System.IO.File]::WriteAllText((Join-Path $Root 'patch-target.txt'), "before`n", [System.Text.UTF8Encoding]::new($false))
@'
# Tasks

- [x] Done task
- [~] Active task
- [ ] Pending task
'@ | Set-Content -Path (Join-Path $Root '.aionui\specs\smoke-plan\tasks.md') -Encoding UTF8
@'
{
  "version": 2,
  "rootPath": "",
  "graphVersion": 2,
  "builtAt": 1,
  "overview": {
    "tagline": "Smoke repo",
    "description": "A tiny repo for MTUI smoke tests.",
    "technologies": ["TypeScript"],
    "entryPoints": ["src/a.ts"]
  },
  "runbook": null,
  "modules": [
    {
      "id": "src",
      "label": "src",
      "layer": "util",
      "summary": "Source module for smoke tests.",
      "fileCount": 1,
      "files": ["src/a.ts"],
      "parentId": null,
      "childModuleIds": [],
      "relatedModuleIds": ["tests"],
      "entryFiles": ["src/a.ts"]
    }
  ],
  "files": [
    {
      "path": "src/a.ts",
      "label": "a.ts",
      "group": "src",
      "layer": "util",
      "summary": "Exports the smoke-test constant.",
      "summarySource": "llm",
      "tags": ["smoke"],
      "symbols": [],
      "language": "typescript",
      "importedBy": 0,
      "fingerprint": null
    }
  ]
}
'@ | Set-Content -Path (Join-Path $Root '.aionui\understand\summary.json') -Encoding UTF8
Push-Location $Root

$Results = @()

function Invoke-MtuiSmokeStep {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name,
        [Parameter(Mandatory = $true)]
        [string[]]$StepArgs
    )

    $Output = & $Binary @StepArgs 2>&1
    $ExitCode = $LASTEXITCODE
    $Text = ($Output | ForEach-Object { $_.ToString() }) -join "`n"
    if ($ExitCode -ne 0) {
        throw "MTUI smoke step failed: $Name`n$Text"
    }
    $script:Results += [pscustomobject]@{ name = $Name; exit = $ExitCode }
    return $Text
}

try {
    [void](Invoke-MtuiSmokeStep 'version' @('--version'))
    [void](Invoke-MtuiSmokeStep 'help' @('--help'))
    $Baseline = (Invoke-MtuiSmokeStep 'policy baseline' @('--json', 'policy', 'baseline')) | ConvertFrom-Json
    $SessionStart = (Invoke-MtuiSmokeStep 'policy session start' @('--json', 'policy', 'session-start', '--owner', 'smoke', '--note', 'smoke pre-existing dirty files')) | ConvertFrom-Json
    $SessionClear = (Invoke-MtuiSmokeStep 'policy session clear' @('--json', 'policy', 'session-clear')) | ConvertFrom-Json
    [void](Invoke-MtuiSmokeStep 'new' @('--json', 'new', 'sample.txt', '--content', "alpha`nmarker`nbeta`nremove-me`n"))
    $Replace = (Invoke-MtuiSmokeStep 'edit replace' @('--json', 'edit', 'sample.txt', 'replace', 'alpha', 'ALPHA')) | ConvertFrom-Json
    $PatchText = @'
diff --git a/patch-target.txt b/patch-target.txt
--- a/patch-target.txt
+++ b/patch-target.txt
@@ -1 +1 @@
-before
+after
'@ + "`n"
    [System.IO.File]::WriteAllText((Join-Path $Root '.aionui\specs\smoke-plan\plan\temporary\change.diff'), $PatchText, [System.Text.UTF8Encoding]::new($false))
    $ApplyPatch = (Invoke-MtuiSmokeStep 'apply patch' @('--json', 'apply-patch', '--file', '.aionui/specs/smoke-plan/plan/temporary/change.diff')) | ConvertFrom-Json
    [void](Invoke-MtuiSmokeStep 'edit line replace' @('--json', 'edit', 'sample.txt', 'line', '2', 'replace', 'MARKER'))
    [void](Invoke-MtuiSmokeStep 'edit insert-after' @('--json', 'edit', 'sample.txt', 'insert-after', 'MARKER', 'after-line'))
    [void](Invoke-MtuiSmokeStep 'edit insert-before' @('--json', 'edit', 'sample.txt', 'insert-before', 'beta', 'before-beta'))
    [void](Invoke-MtuiSmokeStep 'edit delete' @('--json', 'edit', 'sample.txt', 'delete', 'remove-me'))
    $ReadFile = (Invoke-MtuiSmokeStep 'read file' @('--json', 'read', 'sample.txt')) | ConvertFrom-Json
    $ReadRange = (Invoke-MtuiSmokeStep 'read range' @('--json', 'read', 'sample.txt', '--from', '2', '--to', '3')) | ConvertFrom-Json
    $Search = (Invoke-MtuiSmokeStep 'search' @('--json', 'search', 'sample.txt', 'before-beta')) | ConvertFrom-Json
    [void](Invoke-MtuiSmokeStep 'diff last' @('--json', 'diff', '--last'))
    [void](Invoke-MtuiSmokeStep 'diff operation' @('--json', 'diff', '--operation', $Replace.operation_id))
    $History = (Invoke-MtuiSmokeStep 'history operations' @('--json', 'history', 'operations', '--limit', '20')) | ConvertFrom-Json
    [void](Invoke-MtuiSmokeStep 'history record' @('--json', 'history', 'record', '--command', 'bun run test', '--exit-code', '0', '--duration-ms', '123'))
    $Commands = (Invoke-MtuiSmokeStep 'history commands' @('--json', 'history', 'commands', '--limit', '20')) | ConvertFrom-Json
    $Suggest = (Invoke-MtuiSmokeStep 'suggest' @('--json', 'suggest', 'bun')) | ConvertFrom-Json
    $Repair = (Invoke-MtuiSmokeStep 'repair' @('--json', 'repair', '--command', 'bun rn test', '--stderr', 'unknown command')) | ConvertFrom-Json
    @'
Compiling crate_a
Compiling crate_b
Blocking waiting for file lock
Blocking waiting for file lock
Blocking waiting for file lock
error: cannot find module
src/a.ts:1:1
test result: FAILED
'@ | Set-Content -Path (Join-Path $Root '.aionui\specs\smoke-plan\plan\temporary\noisy.log') -Encoding UTF8
    $Compact = (Invoke-MtuiSmokeStep 'compact file' @('--json', 'compact', '--profile', 'auto', '--file', '.aionui/specs/smoke-plan/plan/temporary/noisy.log', '--save')) | ConvertFrom-Json
    $CompactAll = (Invoke-MtuiSmokeStep 'compact all' @('--json', 'compact', '--file', '.aionui/specs/smoke-plan/plan/temporary/noisy.log', '--all')) | ConvertFrom-Json
    $CompactRetrieve = (Invoke-MtuiSmokeStep 'compact retrieve' @('--json', 'compact', '--retrieve', $Compact.saved_id)) | ConvertFrom-Json
    [System.IO.File]::WriteAllText((Join-Path $Root '.aionui\\specs\\smoke-plan\\plan\\temporary\\empty.log'), '', [System.Text.UTF8Encoding]::new($false))
    $CompactEmpty = (Invoke-MtuiSmokeStep 'compact empty' @('--json', 'compact', '--file', '.aionui/specs/smoke-plan/plan/temporary/empty.log')) | ConvertFrom-Json
    @'
print("ok")
'@ | Set-Content -Path (Join-Path $Root '.aionui\specs\smoke-plan\plan\temporary\pass.py') -Encoding UTF8
    @'
print("before failure")
raise AssertionError("focused failure")
'@ | Set-Content -Path (Join-Path $Root '.aionui\specs\smoke-plan\plan\temporary\fail.py') -Encoding UTF8
    $VerifyPass = (Invoke-MtuiSmokeStep 'verify python pass' @('--json', 'verify', 'python', '--spec', 'smoke-plan', '.aionui/specs/smoke-plan/plan/temporary/pass.py')) | ConvertFrom-Json
    $VerifyFailOutput = & $Binary '--json' 'verify' 'python' '--spec' 'smoke-plan' '.aionui/specs/smoke-plan/plan/temporary/fail.py' 2>&1
    $VerifyFailExitCode = $LASTEXITCODE
    if ($VerifyFailExitCode -ne 0) {
        throw "MTUI verify fail case should return JSON with passed=false, not exit non-zero`n$VerifyFailOutput"
    }
    $script:Results += [pscustomobject]@{ name = 'verify python fail'; exit = $VerifyFailExitCode }
    $VerifyFail = (($VerifyFailOutput | ForEach-Object { $_.ToString() }) -join "`n") | ConvertFrom-Json
    $FallbackRun = (Invoke-MtuiSmokeStep 'fallback run' @('--json', 'run', 'git', '--version')) | ConvertFrom-Json
    $FallbackSilent = (Invoke-MtuiSmokeStep 'fallback silent' @('--json', 'run', 'cmd', '/c', 'rem')) | ConvertFrom-Json
    $FallbackMissing = (Invoke-MtuiSmokeStep 'fallback missing program' @('--json', 'run', 'definitely-missing-mtui-program')) | ConvertFrom-Json
    $PreviousErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $FallbackBlockedOutput = & $Binary '--json' 'run' 'Set-Content' 'src/a.ts' 'x' 2>&1
    $ErrorActionPreference = $PreviousErrorActionPreference
    $FallbackBlockedExitCode = $LASTEXITCODE
    if ($FallbackBlockedExitCode -eq 0) {
        throw "MTUI fallback direct-write bypass should exit non-zero`n$FallbackBlockedOutput"
    }
    $script:Results += [pscustomobject]@{ name = 'fallback direct write block'; exit = $FallbackBlockedExitCode }
    $FallbackBlocked = (($FallbackBlockedOutput | ForEach-Object { $_.ToString() }) -join "`n") | ConvertFrom-Json
    $TasksCurrent = (Invoke-MtuiSmokeStep 'tasks current' @('--json', 'tasks', 'current', '--spec', 'smoke-plan')) | ConvertFrom-Json
    $TasksDone = (Invoke-MtuiSmokeStep 'tasks done' @('--json', 'tasks', 'done', '--spec', 'smoke-plan')) | ConvertFrom-Json
    $TasksList = (Invoke-MtuiSmokeStep 'tasks list' @('--json', 'tasks', 'list', '--spec', 'smoke-plan')) | ConvertFrom-Json
    $SummaryFile = (Invoke-MtuiSmokeStep 'summary file' @('--json', 'summary', 'file', 'src/a.ts')) | ConvertFrom-Json
    $InfoFolder = (Invoke-MtuiSmokeStep 'info folder' @('--json', 'info', 'folder', 'src')) | ConvertFrom-Json
    $InformationFile = (Invoke-MtuiSmokeStep 'information file' @('--json', 'information', 'file', 'src/a.ts')) | ConvertFrom-Json
    $InformationRoot = (Invoke-MtuiSmokeStep 'information root folder' @('--json', 'information', 'folder', '.')) | ConvertFrom-Json
    $MapRepo = (Invoke-MtuiSmokeStep 'map repo' @('--json', 'map', 'repo')) | ConvertFrom-Json
    $MapFolder = (Invoke-MtuiSmokeStep 'map folder' @('--json', 'map', 'folder', 'src')) | ConvertFrom-Json
    $MapIntent = (Invoke-MtuiSmokeStep 'map intent' @('--json', 'map', 'intent', 'smoke constant')) | ConvertFrom-Json
    $CompassRead = (Invoke-MtuiSmokeStep 'compass read' @('--json', 'compass', 'read', 'src/a.ts', '--query', 'smoke constant')) | ConvertFrom-Json
    $Context = (Invoke-MtuiSmokeStep 'context intent' @('--json', 'context', 'smoke constant')) | ConvertFrom-Json
    $Memory = (Invoke-MtuiSmokeStep 'memory compact' @('--json', 'memory', 'compact', '--spec', 'smoke-plan')) | ConvertFrom-Json
    $Policy = (Invoke-MtuiSmokeStep 'policy status' @('--json', 'policy', 'status', '--limit', '20')) | ConvertFrom-Json
    $Undo = (Invoke-MtuiSmokeStep 'undo last' @('--json', 'undo', '--last')) | ConvertFrom-Json

    [pscustomobject]@{
        passed = $true
        binary = $Binary
        commandsRun = $Results.Count
        commandNames = $Results.name
        searchMatches = $Search.match_count
        historyOperations = $History.operations.Count
        historyCommands = $Commands.items.Count
        suggestions = $Suggest.suggestions.Count
        repairAvailable = $Repair.repair_available
        repairSuggestion = $Repair.suggested_command
        applyPatchFiles = $ApplyPatch.file_count
        compactedLines = $Compact.output_lines
        compactProfile = $Compact.profile
        compactImportant = $Compact.important_lines
        compactAllLines = $CompactAll.output_lines
        compactSaved = $Compact.saved_id
        compactRetrievedLines = $CompactRetrieve.output_lines
        compactEmptyText = $CompactEmpty.text
        verifyPass = $VerifyPass.passed
        verifyFail = $VerifyFail.passed
        verifyFailSummary = $VerifyFail.summary
        verifyFailLog = $VerifyFail.full_log_path
        fallbackMode = $FallbackRun.mode
        fallbackPassed = $FallbackRun.passed
        fallbackHistory = $FallbackRun.history_recorded
        fallbackSilentPassed = $FallbackSilent.passed
        fallbackSilentOutputLines = $FallbackSilent.output_lines
        fallbackMissingPassed = $FallbackMissing.passed
        fallbackBlockedType = $FallbackBlocked.error_type
        readLines = $ReadFile.returned_lines
        readRange = $ReadRange.text
        currentTask = $TasksCurrent.tasks[0].title
        doneTasks = $TasksDone.tasks.Count
        listedTasks = $TasksList.tasks.Count
        fileSummary = $SummaryFile.summary
        folderSummary = $InfoFolder.summary
        informationFile = $InformationFile.summary
        informationRoot = $InformationRoot.summary
        mapRepoModules = $MapRepo.modules.Count
        mapRepoEntryFile = $MapRepo.modules[0].entry_files[0]
        mapRepoRelatedFolder = $MapRepo.modules[0].related_module_ids[0]
        mapFolderFiles = $MapFolder.files.Count
        mapIntentFiles = $MapIntent.files.Count
        compassRanges = $CompassRead.ranges.Count
        contextCandidates = $Context.candidates.Count
        memoryOperations = $Memory.operation_count
        baselineCount = $Baseline.baseline_count
        sessionBaselineCount = $SessionStart.session_baseline_count
        sessionCleared = $SessionClear.cleared
        policyClean = $Policy.clean
        policyViolations = $Policy.violations.Count
        undoRestoredFile = $Undo.file
    } | ConvertTo-Json -Depth 8
} finally {
    Pop-Location
    Remove-Item -LiteralPath $Root -Recurse -Force
}
