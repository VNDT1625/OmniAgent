# AionUi — Hướng dẫn Codebase Toàn diện

> Tài liệu này ghi lại toàn bộ kiến trúc, cấu trúc thư mục, luồng dữ liệu, quy ước code,
> và các điểm quan trọng của dự án AionUi để agent/developer nắm được codebase nhanh nhất.
>
> **Phiên bản:** 2.1.7 | **License:** Apache-2.0 | **Cập nhật:** 2026-06-09 (Response-language directive — giữ AI trả lời đúng ngôn ngữ cài trong app. Helper renderer `packages/desktop/src/renderer/services/i18n/responseLanguage.ts` (`getResponseLanguageName` map 9 mã ngôn ngữ → endonym; `withResponseLanguageDirective(modelInput, conversationId?)` nối tag tối thiểu `\n\n[Respond in <native>]` (~3-8 token) vào CUỐI model input; khi conversation bị "strict" thì nối directive mạnh "[IMPORTANT — language] ... only in <native>"). ADAPTIVE escalation: bộ dò thuần `packages/desktop/src/renderer/services/i18n/languageDetect.ts` (`foreignLanguageRatio(text, langCode)` 0..1, strip code/URL, đếm script Unicode, Latin en/vi/tr phân biệt bằng mật độ dấu) chấm câu trả lời ở turn-completed (`noteAssistantReply`); bật strict khi ≥0.45, tắt khi ≤0.2 (hysteresis, lưu `sessionStorage` `aionui.langStrict.<id>`). Dò ở `useAionrsMessage` (messageBuffer) + `useAcpMessage` (`turnTextRef`). Mặc định rẻ, chỉ tốn token directive mạnh khi model thật sự trượt ngôn ngữ. Test `tests/unit/i18n/languageDetect.test.ts` 12/12. Cố ý ngắn vì tag được aioncore lưu cùng user message ⇒ re-read mỗi lượt; verbose sẽ tích lũy token. Lặp mỗi lượt nên cũng chống drift sang ngôn ngữ code (English) giữa hội thoại. Lý do dùng lớp desktop: system prompt chat chính nằm ở aioncore (Rust, không sửa) — mô phỏng cách `buildPlanningGuard` augment message. Bubble hiển thị giữ NGUYÊN text thô; chỉ model input mang directive. Bỏ qua khi message rỗng hoặc là slash command (bắt đầu `/`) để không phá lệnh điều khiển. Wire SAU `buildPlanningGuard` ở `packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx`, `packages/desktop/src/renderer/pages/conversation/platforms/acp/AcpSendBox.tsx`, `packages/desktop/src/renderer/pages/conversation/platforms/acp/useAcpInitialMessage.ts`. Không thêm i18n key (directive gửi model, không hiển thị). tsc sạch các file phạm vi.) | **Cập nhật trước:** 2026-06-09 (Slash command `/goal` + `/goal-all` — lệnh thật trong ô chat agent tự chủ (aionrs), KHÔNG chỉ là doc. Module pure `packages/desktop/src/common/chat/slash/goalCommand.ts` (`parseGoalCommand`/`expandGoalCommand`) biến `/goal <yêu cầu>` và `/goal-all <yêu cầu>` thành prompt mở rộng đầy đủ gửi tới agent: nhúng MỤC TIÊU + QUY TRÌNH BẮT BUỘC 100% (9 pha: phân tích query → lấy data → suy luận+bổ sung skill → planning → tối ưu plan cho sub-agent → thực hiện → quick test mỗi bước → quick test tracker cuối → vòng sửa lỗi root-cause), điều kiện dừng (≈100% hoặc hết credit), phục hồi treo (đóng tiến trình, chờ ~5 phút, tự tiếp tục), và ràng buộc autonomous-run/an toàn. `goal-all` = biến thể toàn quyền, mục tiêu 101%. Bubble vẫn hiển thị `/goal ...`, agent nhận `modelInput` đã expand. Wire: `SendBox/index.tsx` thêm prop `enableGoal` + 2 builtin slash item (dropdown gợi ý khi gõ `/`); cả 5 platform send box (aionrs/acp/openclaw/nanobot/remote) gọi `expandGoalCommand` trong `executeCommand` (acp chèn trước `buildPlanningGuard`; openclaw/nanobot/remote expand cả initial-message path) + truyền `enableGoal`. **Auto-resume watchdog** (production-grade): lõi thuần `packages/desktop/src/common/chat/slash/goalWatchdog.ts` (`evaluateWatchdog` + transitions, deterministic, no timers) + hook `renderer/hooks/chat/useGoalWatchdog.ts` (heartbeat từ `responseStream`, ticker 15s) wire ở aionrs — CHỈ kích hoạt khi lệnh đang chạy là `/goal`/`/goal-all`; turn treo (running + im lặng ≥5') → stop → cooldown 5' → tự gửi lại goal gốc, tối đa 3 lần (cap chống loop/cost), giveup thì báo + dừng; resume KHÔNG re-arm (giữ cap), user tương tác/turn xong thì disarm. i18n `conversation.goalCommand.{description,allDescription,autoResumeNotice,autoResumeGiveup}` 9 locale. Test `tests/unit/common/chat/slash/goalCommand.test.ts` 9 + `tests/unit/common/chat/slash/goalWatchdog.test.ts` 11 = 20/20, tsc sạch mọi file phạm vi (lỗi tsc còn lại ở db/spec/experience/rtk là tiền tồn của feature khác), check-i18n in sync. Doc thiết kế: `.claude/commands/goal.md`.) | **Goal Mode (steering bền vững):** `/goal X` bật Goal Mode per-conversation (`packages/desktop/src/renderer/utils/chat/goalMode.ts`, localStorage `aionui.goal.mode.<cid>`); `packages/desktop/src/common/chat/slash/goalSteering.ts` (`GOAL_TURN_REMINDER`/`buildGoalSteering`) + `withGoalSteeringDirective` chèn steering bắt buộc vào MỌI turn ở `AionrsSendBox.executeCommand` (không ghi đè `extra.preset_rules`, không phụ thuộc Rust backend); `/goal off` tắt mode (i18n `conversation.goalCommand.modeOff`). Lưu ý: đảm bảo steering có mặt mỗi turn (code chèn), KHÔNG ép LLM tuân thủ 100% — enforce cứng cần gating tool-loop ở aioncore. Test bổ sung: goalSteering 5 + goalMode.dom 11 + isGoalOff/parse 4. | **Hard enforcement (renderer control-loop):** `packages/desktop/src/common/chat/slash/goalCompliance.ts` (pure: marker `[[GOAL next=continue|done|blocked tests=pass|fail|none phase=N]]`, `parseGoalStatus`+`decideCompliance`+`advanceComplianceState`, cap maxAutoTurns/maxCorrections) + `GOAL_STATUS_CONTRACT` nhồi vào steering; `packages/desktop/src/renderer/hooks/chat/useGoalRunner.ts` (gộp watchdog treo + compliance finish, 1 stream sub): on finish parse marker → accept chỉ khi done&tests=pass, ngược lại tự lái continue/correct/reject (capped) hoặc halt; on stall → stop→cooldown→resend. Wire aionrs (+ badge Goal Mode UI, click tắt). 5 platform đều có Goal Mode steering per-turn + `/goal off`; auto-drive loop chỉ aionrs. i18n thêm `goalCommand.{modeBadge,done,blocked,maxTurns,enforcing}`. Full suite 2580 pass/3 fail(không liên quan)/9 skip; slash+renderer goal tests 49/49. Trần: renderer gate theo marker agent khai báo — ép cứng tuyệt đối cần aioncore. | **Kiểm chứng độc lập (đóng lỗ hổng tự-khai-báo):** `/goal verify <lệnh>` / `/goal verify off` (store `packages/desktop/src/renderer/utils/chat/goalVerify.ts`); khi agent báo done + có verify → `packages/desktop/src/renderer/utils/chat/runWorkspaceVerification.ts` chạy one-shot qua terminal bridge (cwd=workspace, onExit→exitCode, timeout 5'), `useGoalRunner.verify?` chỉ accept khi exit 0, fail thì tự lái lượt fix kèm output (trong cap). Opt-in. i18n `goalCommand.{verifySet,verifyOff,verifyRunning,verifyFailed}`. Test +9 (parseGoalVerify+goalVerify.dom), slash+renderer goal 58/58. Giờ "done" gate bằng exit code thật, không tin lời agent. | **Cập nhật trước:** 2026-06-06 (IDE Database — client SQL đa kết nối tích hợp trong app + agent dùng được. Backend `process/ide/db/`: `dbTypes` (DbKind sqlite|postgres|mysql, config/schema/column/result), `dbDriver` (contract + `isReadOnlySql`/`splitStatements`/`normalizeCell` thuần), 3 driver `sqliteDriver` (better-sqlite3, đã bundle), `postgresDriver` (pg), `mysqlDriver` (mysql2) — mỗi driver connect/getSchema/getColumns/query/close + read-only guard + row cap; `dbConnectionStore` (config JSON ở userData + **password mã hóa tại chỗ qua Electron `safeStorage`** trong cùng record, fallback base64; crypto seam inject); `dbService` singleton (mở driver lazy theo id, dùng chung 2 plane); `dbWiring` (safeStorage crypto, driver factory map); `dbBridge` (kênh `ide.db-*` envelope) wire ở `initAllBridges()`. Driver mới: `pg`, `mysql2`, `@types/pg`. Renderer `renderer/pages/studio/ide/db/`: `dbClient` (timeout guard), `useDatabasePanel`, `DbConnectionModal` (form theo engine + Test), `DatabasePanel` (rail connections + schema tree + SQL editor Ctrl/Cmd+Enter + bảng kết quả) → **mode `database`** trong IdeWorkspace activity bar (icon DataSheet + palette). **Agent plane**: tool `db_list_connections`/`db_list_tables`/`db_describe_table`/`db_query` thêm vào IDE MCP `aionui-ide` (dep `db?` optional, wire `getDbService()`), `superGuidance` thêm hướng dẫn. i18n `ide.mode.database` + block `ide.db.*` 9 locale. Test `tests/unit/ide/db/` (dbDriver 13 + dbService/store 7 + sqlite integration 6 skip ngoài Electron ABI) + ideServer +1 = 23 pass; tsc sạch, check-i18n pass. Xem `.kiro/status.md`.) | **Cập nhật trước:** 2026-06-06 (Quick Test cho Agent (Super) — agent giờ tự chạy Quick Test qua MCP. Thêm `packages/desktop/src/process/ide/quickTestService.ts` (Agent-plane twin của Quick Test: `runSession({platform,rootPath,target,durationMs})` khởi tracer đúng platform, quan sát có giới hạn thời gian + **early-exit khi gặp firstError**, stop + map trace→code graph; TÁI DÙNG đúng 2 tracer + `buildTraceContext` của UI, deps inject nên test được; clamp duration ≤60s). Lộ qua **tool `ide_quick_test`** trong IDE MCP server `aionui-ide` (`packages/desktop/src/process/ide/mcp/ideServer.ts` thêm `IdeServerDeps.quickTest?` optional → chỉ expose khi inject; `ideMcpWiring.getQuickTestRunner()` resolve focused WebContents qua Electron + `openNativeLogStream` + `loadGraph`). `superGuidance.IDE_TOOLS_RULES` thêm dòng hướng dẫn `ide_quick_test` để Super agent biết dùng. Test `tests/unit/ide/quickTestService.test.ts` 5 + ideServer +1 (quick*test) = 30/30 (cùng 2 tracer); tsc sạch. Xem `.kiro/status.md`.) | **Cập nhật trước:** 2026-06-06 (Quick Test đa nền tảng — mở rộng IDE Quick Test (trước chỉ web qua CDP) sang **android + windows**. Thêm `packages/desktop/src/process/ide/quickTestNativeTracer.ts` (observer thụ động dùng chung shape `RuntimeTrace`: parse log line→`TraceEvent` qua `mapNativeLogLine`; crash/`FATAL EXCEPTION`/priority `F`→exception, `E/`→console error, `W/`→warn; ghi exit code≠0 thành exception) + `packages/desktop/src/process/ide/quickTestNativeStream.ts` (real `NativeStreamOpener`: android = `adb -s <serial> logcat` reuse `toolResolver.resolveAdb`, clear buffer trước; windows = spawn `.exe` stream stdout/stderr). `packages/desktop/src/process/ide/quickTestTracer.ts` đổi `TracePlatform='web'|'android'|'windows'`, export helper `findFirstError`. `quickTestBridge` thêm `QtStartRequest.platform/target` + chọn tracer theo platform + inject `openNativeStream` (wire ở `process/bridge/index.ts`). `ideClient.qtStart(rootPath, platform?, target?)`. `QuickTestPanel` thêm Select platform + Input target (serial/exe), idle steps + lỗi `noDevice`/`noApp` theo platform. i18n `ide.quicktest.{platform*,androidStep*,windowsStep*,target*Hint,noDevice,noApp}`9 locale. Test`tests/unit/ide/quickTestNativeTracer.test.ts`12 mới (tracer+native 17/17), tsc sạch, check-i18n pass. Xem`.kiro/status.md`.) | **Cập nhật trước:** 2026-06-06 (Spec-driven workflow ngang/hơn Kiro — thêm lớp phân tích spec "Kiro-grade" mà trước còn thiếu. Pure shared `common/spec/`(4 file, không I/O, renderer+main dùng chung):`packages/desktop/src/common/spec/earsRequirements.ts`parse + validate EARS (5 pattern ubiquitous/event/state/unwanted/optional + check normative SHALL/MUST → diagnostics),`packages/desktop/src/common/spec/traceability.ts`ma trận Req↔Task↔Test (đọc ref`(Req: R1)`trong tasks.md + mention trong verification.md → coverage/uncovered/orphan/verified),`packages/desktop/src/common/spec/phaseGates.ts`parse`## Phase N`+ CHECKPOINT + Definition of Done → gate readiness + active phase,`index.ts`barrel`analyzeSpec`+`computeSpecScore`0..100 (weighted). Bridge`packages/desktop/src/process/ide/specLifecycleBridge.ts`thêm`buildSpecAnalysis`+ kênh`ide.spec-analyze`(đọc 3 file → gọi pure); client`ideClient.specAnalyze`. UI `packages/desktop/src/renderer/pages/studio/ide/components/SpecManagerPanel.tsx`(Arco Progress gauge score + EARS per-criterion pattern tag + coverage matrix + phase gates + DoD badge + diagnostics) thành **mode`spec`** mới trong `IdeWorkspace`activity bar (icon FileCode + palette command). i18n`ide.mode.spec`+ block`ide.spec.*`9 locale. Test:`tests/unit/spec/`23 (pure) + bridge analyze 1 +`SpecManagerPanel.dom`3 = 27 mới, tsc sạch mọi file phạm vi, check-i18n ide.json đủ key. Nâng mảng spec/task lifecycle ~7.8→~8.3. Xem`.kiro/status.md`"GOAL: Spec-driven".) | **Cập nhật trước:** 2026-06-06 (Tối ưu phân bổ tài nguyên — hiểu laptop hơn + giảm lag: thêm`packages/desktop/src/process/resource/gpuProbe.ts`detect GPU rời qua Electron`app.getGPUInfo('basic')`(heuristic thuần`hasDiscreteGpuFromDevices`, không thêm dependency) nối vào `systemProbe.getHasDiscreteGPU`(trước luôn`false`⇒ preset`performance`gần như không bao giờ được gợi ý);`balancePolicy.suggestPreset`thêm đường`performance`cho máy rất mạnh KHÔNG có GPU rời (≥32GB + ≥12 core);`browserViewManager.createTab`đặt`backgroundThrottling`theo cờ`background`(tab user ẩn lại được Chromium throttle ⇒ tiết kiệm CPU/GPU, chỉ tab research nền tắt throttle); thêm`packages/desktop/src/renderer/utils/hardwareConcurrency.ts` (`recommendedConcurrency`theo`navigator.hardwareConcurrency`) thay magic-number ở `useMcpConnection`(4→theo core) và`companyPipeline`(3→theo core). Test mới`tests/unit/resource/`+`tests/unit/renderer/hardwareConcurrency.dom.test.ts`20/20; hồi quy browser 145/145; tsc CLEAN. Xem`.kiro/status.md`.) | **Cập nhật trước:** 2026-06-03 (9Router connector GĐ2 — nút **Apply** ghi config tự động: `packages/desktop/src/common/router9/applyPlan.ts`(PURE expandHome/deepMerge/mergeConfigContent),`packages/desktop/src/process/router9/router9Applier.ts`(ghi atomic + backup`.bak`, recompute plan ở Main, fs seam DI) + `packages/desktop/src/process/router9/router9Bridge.ts`kênh`router9.apply-plan`wire ở`initAllBridges()`, renderer `packages/desktop/src/renderer/pages/settings/router9/router9BridgeClient.ts`+ nút Apply trong`Router9ConnectorPanel`. i18n +8 key `settings.router9._`(9 locale). Test`tests/unit/router9/`28/28, tsc/i18n sạch. Điều tra: freemodel.dev chỉ phục vụ claude qua Claude Code CLI → dùng Claude Code (CLI agent) trỏ 9Router. Xem callout "9Router — GĐ2" +`.kiro/status.md`.) | **Cập nhật trước:** 2026-06-02 (Music Studio (Tomni Agentic music) — capability làm nhạc cho CẢ user lẫn agent, gated sau cờ `MUSIC_STUDIO_ENABLED=false`. Workspace package mới `packages/music-core` (`@aionui/music-core`, headless thuần TS: schema/engine commands/scheduler+render/WAV/synth, analysis "đôi tai" pitch-YIN+key-Krumhansl+tempo, theory+vocal-tune planning, producer brain, agent `dispatchTool`). Renderer `pages/music/`(UI Arco +`useMusicPlayer`Tone.js realtime +`musicClient`); process `process/music/`(fileProjectRepo node:fs + musicBridge`music._`render WAV/stems + MCP`aionui-music`host/wiring/register gated). Route`/music`+`SiderMusicEntry`+ i18n module`music`(9 locale). Dep mới`tone@15.0.4`. Perf fix: cap chroma DFT ~5kHz + cap số frame → test 22.5s→4.4s. Test `tests/unit/music/`17/17 (core 10 + mcp 7), tsc sạch, build OK. Xem`.kiro/status.md`"HOÀN TẤT TÍCH HỢP".) | **Cập nhật trước:** 2026-06-02 (Studio Editor AI — thay panel "AI yếu" bằng chat thật`<ChatConversation>`(hook`useDocChat`, conversation pin `extra.workspace`) + MCP `aionui-office-editor`13 tool`office**` sửa live ONLYOFFICE qua RPC Main→Renderer (`editorToolsBridge`/`editorToolsProvider`/`editorToolsClient`+ server/host/wiring + đăng ký ở`runBackendMigrations`); xóa `useDocAssistant`/`useDocAgent`/`docAgentStore`/`extractCodeBlock`/`useDocAgentActivity`; i18n thay `studio.assistant.\*`+`studio.create.pickModel`(9 locale). tsc EXIT=0, studio 31/31 + editor 16, i18n PASS. Xem callout "Studio Editor AI".) | **Cập nhật trước:** 2026-06-01 (Office/PDF mở theo PATH — bỏ giới hạn 256 MB của aioncore: docx/xlsx/pptx/pdf không còn nạp cả file qua`POST /api/fs/read-buffer`(nơi aioncore chặn >256 MB + tốn RAM).`useEditorFile` thêm content mode **`'none'`** (bỏ qua đọc whole-file, `load`settle rỗng,`save`no-op — adapter tự đọc/lưu theo path);`ADAPTER*CONTENT_MODE` đặt docx/spreadsheet/slide/pdf=`'none'`. Office mở theo path qua integration host `packages/desktop/src/process/studio/onlyOfficeServer.ts`; `PdfAdapter`viewer fallback đọc bytes lazy theo path qua`studio.read-binary`(Node fs, không cap). File Office/PDF rất lớn nay mở được. getDiagnostics sạch, tsc không lỗi mới, test editor+studio 50/50.) | **Cập nhật trước:** 2026-06-01 (Studio Editor — không gian tài liệu + Office mặc định + PDF edit:`StudioEditorView` thêm nút **fullscreen** (`position:fixed`phủ cửa sổ, Esc thoát, không remount editor) + nút **ẩn/hiện thanh công cụ** (chevron) để lấy lại chiều cao cho tài liệu. Bỏ toggle "Sửa (Office)/Sửa" ở docx/xlsx/pptx — luôn mở Office trước, lỗi thì **tự** fallback editor nhẹ qua callback`onFatalError`mới của`OnlyOfficeEditor`+ strip`OfficeFallbackNotice`(Thử lại Office / Cài đặt DS). **PDF giờ edit được**:`documentTypeFor`nhận`pdf`→ ONLYOFFICE Docs 7.2+ mở PDF editor (ghi chú/thêm chữ/ký/điền form, lưu về đĩa),`PdfAdapter` fallback trình xem Chromium khi Office lỗi (PDF không có Automation API → bỏ qua connector AI). i18n: +`studio.editor._`, +`editor.office._`; xoá key chết `editor.{docx,spreadsheet,slide}.mode._`/`.formattedFailed`+`editor.pdf.{scopeNotice,annotate,fillForm}`(9 locale). getDiagnostics sạch, i18n:types+check-i18n pass.) | **Cập nhật trước:** 2026-06-01 (Terminal manager — chức năng quản lý Terminal mới ở`/settings/terminal`(desktop-only): backend`process/terminal/`(8 file) —`IPtyBackend`+ **child*process backend (KHÔNG node-pty, zero native dep)\*\*,`terminalManager`(registry session interactive + scrollback + event),`systemProcesses`(đếm/list shell OS read-only qua tasklist/ps),`terminalScheduleStore`+`terminalScheduler`(croner, fire script vào session mới — vd mở 9router theo lịch),`terminalBridge`(kênh`terminal.*`envelope always-resolve) +`terminalWiring`; wire ở `initAllBridges()`(scheduler.start arm lịch ngay). Renderer`renderer/pages/terminal/`(3 tab Sessions/System/Schedules, view tự viết Arco strip-ANSI, KHÔNG xterm) +`terminalBridgeClient`timeout-guard + route + nav SettingsSider. i18n module`terminal`9 locale. Test`tests/unit/terminal/`36/36, tsc terminal sạch. Giai đoạn 3 (nhúng panel vào IDE) chưa làm. Xem callout "Terminal manager" +`.kiro/status.md`.) | **Cập nhật trước:** 2026-06-01 (PRD Feature Packs — kế hoạch dài hạn modular hoá app: tách lõi (Chat) + feature pack tải về theo yêu cầu (Browser/Studio/Manager/Testing/Monitor/Company/IDE…). Đã CHỐT NGUYÊN TẮC, **HOÃN TRIỂN KHAI** đến khi feature chính ổn định (gần ra mắt v3) để tránh rework. Tài liệu đầy đủ: `docs/prds/feature-packs/README.md`. Lộ trình 3 giai đoạn (asset pack → code pack thử nghiệm → modular toàn bộ).) | **Cập nhật trước:** 2026-06-01 (Content-extraction service chung — `process/services/contentExtract/`: transcript YouTube qua **yt-dlp** → anonymous fetcher cũ (fallback); file→Markdown qua **markitdown**/`uvx`→ Node fallback (mammoth/officeparser/turndown); facade`extract({kind:youtube|file|html|auto})`; wiring Browser `fetchTranscript`+ Manager`docExtractor`+ tool MCP`extract*content`. Không bundle, công cụ ngoài resolve lúc chạy, degrade an toàn. Test 22/22, tsc EXIT=0.) | **Cập nhật trước:** 2026-06-01 (IDE Understand — gen summary theo NGÔN NGỮ HỆ THỐNG: summary/tours/overview được LLM sinh bằng đúng ngôn ngữ hiển thị (thread `i18n.language`→`kgBuild(rootPath,model,language)`→`KnowledgeBuildRequest.language`→`builder.build({language})`); prompt thêm `langDirective`(viết prose theo ngôn ngữ, giữ nguyên code identifiers/path/JSON keys); fallback summary LOCALIZED 9 locale ở`packages/desktop/src/process/ide/fallbackSummaryLocale.ts`; `graph.language`lưu + incremental reuse chỉ giữ summary cũ khi ngôn ngữ khớp (đổi ngôn ngữ → re-summarize, live rebuild cũng truyền language);`OverviewPanel`hint rebuild khi`graph.language`lệch UI (key`ide.understand.overview.langMismatch`). Test builder 24, test ide 82/82, tsc IDE sạch. LƯU Ý: lỗi tsc ở `process/services/contentExtract/`là feature untracked của agent khác, ngoài phạm vi.) | **Cập nhật trước:** 2026-06-01 (IDE — nhớ phiên + mở folder khác có cảnh báo:`useIdeWorkspace`persist`{rootPath, openFiles, activeFile}`vào`localStorage` `studio.ide.session`+ khôi phục khi vào lại IDE (cờ`restoring`hiện spinner thay vì màn hình mở folder); thêm thanh tab`EditorTabs`(đóng từng file) + dấu chấm "chưa lưu";`UniversalEditor`thêm prop`onDirtyChange`báo dirty lên, hook gom qua`markDirty`/`dirtyFiles`/`hasUnsaved`; nút header "Open another folder" → `Modal.confirm`cảnh báo mất thay đổi chưa lưu trước khi`pickFolder`reset tabs/dirty. i18n`ide.workspace.*`(9 locale), tsc sạch, test`tests/unit/ide/` 78/78 (+`tests/unit/ide/useIdeWorkspace.dom.test.ts`6). Xem callout "IDE Understand — incremental/realtime/C4" cho phần trước.) | **Cập nhật trước:** 2026-06-01 (IDE Understand — incremental + realtime + C4 + diff + fallback: builder thêm fingerprint pure (FNV-1a) + fallback summary deterministic (node nào LLM bỏ qua vẫn có tóm tắt, gắn`summarySource`llm/fallback) + reuse incremental khi fingerprint trùng +`extractExternals`(C4 Context) + polyglot symbols Python/Rust/Go/Java;`packages/desktop/src/process/ide/repoWatcher.ts`(realtime DI fs.watch + debounce) + kênh`ide.kg-watch-start/-stop`+ emitter`ide.kg-changed`; renderer `packages/desktop/src/renderer/pages/studio/ide/graphModel.ts`pure (deriveC4 4 cấp Context/Container/Component/Code + computeImpact diff + liftChangedToView),`packages/desktop/src/renderer/pages/studio/ide/components/layerColors.ts`, `packages/desktop/src/renderer/pages/studio/ide/components/C4GraphView.tsx`(columns/force, diff overlay),`packages/desktop/src/renderer/pages/studio/ide/components/OverviewPanel.tsx`(overview-first),`packages/desktop/src/renderer/pages/studio/ide/components/NodeDetailRail.tsx`(summary badge);`useUnderstand`thêm Live + changedFiles. i18n 9 locale, tsc sạch, test ide 72/72. Xem callout "IDE Understand — incremental/realtime/C4" bên dưới.) | **Cập nhật trước:** 2026-06-01 (IDE Chat — bỏ 2 AI yếu (mode Ask + mode Agent) trong Studio › IDE, thay bằng MỘT mode **Chat** đa-tab tái dùng hệ conversation/CLI-agent chính: mỗi tab =`TChatConversation`thật pin`extra.workspace = rootPath`(CLI agent chạy cwd là folder mở, đọc mọi subdir) + embed`<ChatConversation>`. Xóa 8 file (`AgentChatPanel`/`ExplainPanel`/`useCodeAgent`/`codeAgentRunner`/`codeAgentBridge`/`ideExplainBridge`+ 2 test); thêm`packages/desktop/src/renderer/pages/studio/ide/useIdeChat.ts`+`packages/desktop/src/renderer/pages/studio/ide/components/IdeChatPanel.tsx`; activity bar IDE giờ **Files/Understand/Chat/Wiki**. i18n `ide.mode.chat`+`ide.chat._`(9 locale, bỏ`ide.explain._`/`ide.agent.\_`). tsc sạch, `tests/unit/ide/`66/66. Xem callout "IDE Chat — bỏ Ask+Agent" trong`.kiro/status.md`.) | **Cập nhật trước:** 2026-06-01 (Đợt 13 — Automation liên kết App ↔ Cloud ↔ Social: 6 node kind mới cho Studio › Automation (Make Video+render mp4 / Editor / Cloud upload S3-WebDAV / Email SMTP / Facebook / TikTok), connector DI ở `process/automation/connectors/`, i18n 9 locale, test 35/35. Xem callout "Đợt 13" bên dưới.) | **Cập nhật trước:** 2026-06-01 (Company — xóa công ty thật + chủ tịch/role nhận đúng identity + bar gen chạy ngầm: (1) thêm kênh `company.delete-company` (bridge+client+`ICompanyConfigStore.deleteCompany`xóa hẳn folder`<userData>/companies/<id>/`); nút X picker → nút Delete có Popconfirm; `useCompanyState.forgetCompany`xóa đĩa + dọn map`github.com/VNDT1625/OmniAgentpany.roleConversations`⇒ tạo lại cùng tên là sạch hoàn toàn. (2)`openRoleChat`LUÔN nhồi briefing đầy đủ (identity + soul/workflow qua`composeSoul`) vào `extra.preset_context`cho cả CLI lẫn assistant + gửi "primer turn" (SYSTEM BRIEFING) sau khi tạo conversation ⇒ chủ tịch tự biết role/company/rules; option`skipPrimer`cho pipeline. (3)`GenerationProgress`seed`percent`từ`elapsed`khi remount ⇒ đổi tab quay lại bar không reset về 0; thêm hint "đang chạy ngầm". i18n`company.picker.delete*`/`company.describe.tabSwitchHint`(9 locale). Test`tests/unit/company/`**117/117**. Xem callout "Company — delete + identity + bg progress" bên dưới.) | **Cập nhật trước:** 2026-06-01 (Browser web-agent chạy ngầm khi rời trang — transcript + cờ running của web-agent chuyển từ React state`useAgentChat`sang store module-level`packages/desktop/src/renderer/pages/browser/agentChatStore.ts`(subscribe`onAgentEvent`always-on + mirror`sessionStorage`); rời trang Browser không còn mất transcript/ngừng nghe (runner Main vốn vẫn chạy ngầm). `useAgentChat`thành binding`useSyncExternalStore`, API public giữ nguyên. Test `tests/unit/browser/agentChatStore.dom.test.ts`(4),`tests/unit/browser/`136/136. Xem callout "Browser web-agent chạy ngầm khi rời trang" bên dưới.) | **Cập nhật trước:** 2026-06-01 (CLI agent cho tác vụ AI nền — module dùng chung`process/services/agentChat/` cho phép các surface AI nền (Browser web-agent, Studio chat, IDE explain/wiki, Make Video, Testing scenario/app-detect) chạy bằng **CLI agent** (Claude Code/Codex/Gemini CLI…) thay vì chỉ provider api*key. Model id mã hoá `cli:<agentId>` → `withCliAgent`/`runAgentChatMessages` định tuyến qua driver tạo conversation tạm + chờ turn (WS riêng cho Main + poll REST) + đọc kết quả + cleanup. Picker Browser thêm nhóm "CLI Agents". Xem callout "Đợt 11 — CLI agent cho tác vụ AI nền" bên dưới.) | **Cập nhật trước:** 2026-06-01 (gỡ bỏ "Make Film Studio" — placeholder phase 2 chưa có pipeline: xóa `MakeFilmStudio.tsx`, mode `film` trong `StudioPage`, prop `onMakeFilm` + nút trong `StudioDashboard`, key i18n `studio.makeFilm`/`studio.film.*`ở cả 9 locale; nút Make Video lên làm action chính của rail. Studio sub-app còn lại: Make Video, Automation, Repo IDE, IDE.) | **Cập nhật trước:** 2026-05-31 (đối chiếu lại với CODE thực tế — chỉ tin code. Đợt 1: bổ sung`process/cron/`+`process/manager/`, route `/manager`, file thiếu cho browser/studio/testing/monitor, i18n 30 module, built-in MCP cron/manager. Đợt 2 (dùng sub-agent verify song song Sections 10/11/13/14/15): Section 10 bổ sung cột `source`/`channel\*chat\*id`(conversations),`hidden`(messages),`session\*mode`(teams),`files`(mailbox) + liệt kê các bảng`assistant\**`/`cron*jobs`/`remote\*agents`/`acp_session`; Section 11 sửa Teams API (bỏ `PUT /api/teams/:id`không tồn tại → các sub-resource thật); Section 13 thêm`components/devtools`, `components/workspace`, `IconParkHOC`, `ShimmerText`; Section 14 thêm `hooks/assistant`, `hooks/config`+ các hook lẻ; Section 15 thêm`utils/devtools`, `utils/workspace`, file gốc `utils/`+`writeBinaryFile`. Đợt 3: Studio ONLYOFFICE full-edit on-demand — `packages/desktop/src/process/studio/documentServerManager.ts`(ensureDocumentServer: URL cấu hình hoặc tự start Docker DS), kênh`studio.office-ensure-server`, chế độ "Office" WYSIWYG cho cả 3 adapter docx/xlsx/pptx, i18n `editor.onlyoffice.\*`. Đợt 4: Browser agent — fix điều hướng SPA (emitter `browser.tab-updated`) + grounding URL tab hiện tại, transcript passive/active (tab ẩn), lớp `process/browser/research/`(readability + summarizer map-reduce + deepResearch đa nguồn có citation), tool`summarize`/`deep_research`. Đợt 8 (đối chiếu lại toàn bộ feature từ code): Section 1 tách bảng tính năng thành (A) lõi + (B) Tomni Agentic/Studio/Manager (13 chức năng mở rộng có route/bridge/i18n riêng); sửa i18n Section 16 từ 30 → **33 module** (thêm `automation`/`ide`/`makeVideo`); bỏ con số cứng "21 Assistants" (code không seed cố định — assistants do backend quản lý qua `/api/assistants`). Đợt 9: bổ sung thư mục `process/editor/` (`packages/desktop/src/process/editor/editorFrameStore.ts`+`packages/desktop/src/process/editor/editorControlBridge.ts`) vào cây Section 5.1 và thêm `editor-control`vào danh sách bridge đăng ký trong "Lưu ý wiring" (khớp`registerEditorControlBridge()`trong`initAllBridges()`). Đợt 10: gộp IDE Studio (`StudioIde`+`RepoIntelView`→`IdeWorkspace` 4 chế độ Files/Map/Ask/Wiki) + thêm Wiki kiểu DeepWiki (`packages/desktop/src/process/ide/ideWikiBridge.ts`+`packages/desktop/src/process/ide/wikiPlanner.ts`+`packages/desktop/src/process/ide/ideProvider.ts`; kênh `ide.wiki-plan`/`ide.wiki-section`) — xem callout "Đợt 8 — IDE hợp nhất + Wiki" bên dưới)
> tiếp
> **Cập nhật 2026-06-09 (IDE Wiki → production-grade: verify-doc → tự sửa → viết + tự đánh giá/cải thiện → lưu bền):**
> nâng tab Wiki (DeepWiki) của IDE từ "sinh lại mỗi lần, chỉ ở React state" lên pipeline bền sản xuất ở
> `process/ide/wiki/`. **(1) Không tin doc — kiểm chứng**: `packages/desktop/src/process/ide/wiki/docVerify.ts` (PURE) đối chiếu mọi claim kiểm
> được của doc (đường dẫn file trong `inline code`/link + lệnh `npm run X`) với code thật; sai thì tự sửa
> (moved-path khi basename duy nhất, near-miss script edit-distance ≤2) và ghi lại doc đã sửa. **(2) Agent
> khác viết wiki TỪ doc đã verify**: `packages/desktop/src/process/ide/wiki/wikiBootstrap.ts` (deps injected) chạy scan→verify→fix→plan→write→save;
> mỗi mục đi qua **vòng tự đánh giá–cải thiện** `packages/desktop/src/process/ide/wiki/wikiRefine.ts` + `packages/desktop/src/process/ide/wiki/wikiCritic.ts` (PURE: chấm
> placeholder/too-short/hallucinated-path/low-grounding/missing-diagram/no-subheadings/duplicate-title/
> coverage; `hasConverged` dừng khi điểm ≥0.95, hoặc lượt cải thiện không tăng đủ, hoặc chạm trần) — "hoàn
> thiện tới khi không tối ưu được nữa". Coverage chỉ bật khi prose tiếng Anh (tránh phạt oan wiki vi-VN…).
> **(3) Lưu bền**: `packages/desktop/src/process/ide/wiki/wikiStore.ts` ghi `userData/ide-wiki/<hash>.json` + export người-đọc-được
> `<repo>/.aionui/wiki/` (atomic tmp+rename, fs injected) → sống qua restart, mở lại dùng ngay không gọi model.
> Bridge `packages/desktop/src/process/ide/wiki/wikiBuildBridge.ts` (`ide.wiki-build`/`ide.wiki-load` + emitter `ide.wiki-progress`, wire Node
> fs + `runIdeChat`), đăng ký ở `initAllBridges()`. Renderer: `packages/desktop/src/renderer/pages/studio/ide/useRepoWiki.ts` (load persisted on open + build
> với progress) + `packages/desktop/src/renderer/pages/studio/ide/components/WikiPanel.tsx` (phase strip + "documentation check" report + điểm chất lượng + saved badge).
> i18n `ide.wiki.*` (phase\*\*/building/verifiedDocs/docsFixed/quality/savedBadge… 9 locale). Verify: `tests/unit/ide/wiki/` +`tests/unit/ide/wiki/wikiCritic.test.ts` (16) +`tests/unit/ide/wiki/wikiRefine.test.ts` (6) + bootstrap refine test = **66 pass** (toàn `tests/unit/ide` 503+); tsc + oxlint (0/0) + check-i18n sạch.
> Bridge cũ `ide.wiki-plan`/`ide.wiki-section` (ideWikiBridge) còn đăng ký nhưng renderer không dùng nữa.

**Cập nhật 2026-06-09 (IDE Database → production-grade: safeStorage + URL/DSN + pool + index/FK + script + export + test pg/mysql):**
nâng feature IDE Database (client SQL đa kết nối trong app, dùng chung cho UI + agent) lên mức bền sản xuất.
**(1) Secret an toàn hơn** — bỏ native `keytar` (mong manh, không phải pattern repo), chuyển password sang
mã hóa tại chỗ qua Electron `safeStorage` (giống `gitCredentialStore`): blob mã hóa nằm trong
`connections.json` (`encryptedPassword`/`osEncrypted`), giải mã CHỈ ở Main; edit để trống password thì giữ
blob cũ; crypto seam inject để test. **(2) Kết nối Docker/cloud dễ** — module thuần `packages/desktop/src/process/ide/db/dbUrl.ts`
(`parseDbUrl`) parse `postgres://`/`mysql://`/`sqlite://`/bare path → điền form; ô "Connection URL" trong
`DbConnectionModal` dán là tự điền host/port/db/user/pass/ssl. **(3) Bền hơn** — `postgresDriver`/`mysqlDriver`
dùng **connection pool** (pg.Pool / mysql2 createPool) + probe `SELECT 1` lúc connect → idle drop / Docker
restart tự reconnect. **(4) Đầy đủ tính năng DB** — driver contract thêm `getIndexes`/`getForeignKeys`;
`dbService.getTableDetail` gộp cột+index+FK; `queryScript` chạy script nhiều câu lệnh (tách `;`, dừng ở lỗi
đầu); kênh mới `ide.db-table-detail`/`ide.db-query-script`. **(5) Driver test được** — 3 driver nhận
`ModuleLoader` inject → test pg/mysql bằng fake module (read-only guard, row cap, introspection grouping)
không cần DB thật. **(6) UI** — schema tree hiện index/FK, ô lọc bảng (khi >8 bảng), nút export **CSV/JSON**
(`packages/desktop/src/process/ide/db/dbExport.ts` thuần); editor Run chạy cả script. **(7) Agent plane** — `db_describe_table` (MCP `aionui-ide`)
giờ trả cột + index + foreign key. i18n `ide.db.{exportCsv,exportJson,pasteUrl,pasteUrlPlaceholder,urlInvalid,urlFilled,filterTables,noMatch}`
9 locale. Test `tests/unit/ide/db/` (driver/url/export/service/store + pg/mysql fake + DatabasePanel.dom + sqlite integration) + ideServer db tools = toàn bộ ide **481 pass**; oxlint 0, tsc sạch mọi file db, check-i18n in-sync. Xem `.kiro/status.md`.
**Cập nhật trước 2026-06-09 (Make Video → production-grade: local/CLI/API key + retry/timeout + hủy + test):**
nâng Studio › Make Video lên mức bền sản xuất. **(1) Picker script đủ "local LLM · CLI · API key"** —
helper thuần `packages/desktop/src/renderer/pages/studio/makevideo/scriptModelOptions.ts` (`buildScriptModelOptions`) gộp
provider model (cloud API key HOẶC server local OpenAI-compatible như Ollama/LM Studio) **và** CLI agent
(`cli:<id>` qua `makeCliModelId`, mirror IDE Understand) vào một `Select` có nhóm Provider/CLI; backend
`runScript` vốn đã route qua `runAgentChatMessages` nên CLI/local chạy ngay. **(2) Hardening backend** —
`packages/desktop/src/process/makevideo/retry.ts` (`withRetry` backoff+jitter, `isTransientError` phân loại 408/425/429/5xx +
network flap, KHÔNG retry abort/4xx/"chưa cấu hình") wrap script/image/voice + submit fal.ai;
`fetchWithTimeout` (AbortController 120s) cho script. **(3) JSON robust** — `process/makevideo/
scriptParse.ts` tách `parseScenes` (bridge re-export giữ tương thích) + repair (bỏ trailing comma, smart
quotes, zero-width, quét ngoặc bỏ qua ngoặc trong chuỗi). **(4) Hủy** — `useMakeVideo.cancelGeneration`
(cờ cooperative, dừng vòng render-all sau cảnh hiện tại) + nút Stop trong thanh tiến trình. i18n
`makeVideo.controls.{providerGroup,cliGroup,noModels,stop,stopping}` 9 locale. Test mới `tests/unit/
makevideo/` (retry, scriptParse, scriptModelOptions, voiceGen, videoClipGen, finalExport) → 60/60 pass
(voiceGen/videoClipGen/finalExport trước đây chưa có test). tsc make-video sạch, oxlint 0 error, i18n
in-sync. Kèm fix chặn build: khôi phục dòng `const loadReport = useCallback(...)` bị một phiên trước xóa
nhầm trong `packages/desktop/src/renderer/pages/testing/useTestingState.ts` (lỗi cú pháp chặn typecheck toàn repo). Xem `.kiro/status.md`.
**Cập nhật 2026-06-09 (IDE editor → code-aware: Tab completion, auto-LSP, quick-run, graph-in-editor):**
một loạt nâng cấp biến editor IDE thành "code-aware" tận dụng graph sẵn có. **(1) FS context-menu hoàn
thiện** — thêm provider `ide.create-dir`/`ide.rename-file`/`ide.delete-file` (trước thiếu → New Folder/
Rename/Delete treo 15s) vào `ideFileBridge`. **(2) Tab completion** (ghost text) — bridge
`ide.inline-complete` (`packages/desktop/src/process/ide/lang/ideCompletionBridge.ts`, FIM prompt qua `runIdeChat`, chặn
`cli:*`, strip fence) + `ideProvider.resolveDefaultModel`; renderer Monaco `registerInlineCompletions
Provider` debounce 300ms + cancel token. **(3) Auto-LSP** — `ide.lsp-ensure` (catalog→ensureInstalled,
npm auto-tải / binary adopt-PATH) thay opt-in; `TextCodeAdapter.maybeAttachLsp` tự bật; F12/Shift+F12
ưu tiên LSP qua `ide.nav.request.lsp` (fallback heuristic). **(4) Quick-run terminal** — menu chuột phải
cây file "Run in terminal ▸" (`packages/desktop/src/renderer/pages/studio/ide/quickCommands.ts` pure: npm scripts + `mtui map/compass` + `git status`),
emitter `ide.terminal.run` → `IdeTerminalPanel` mở dock + chạy ở cwd đúng. **(5) Graph-in-editor** —
hover import hiện summary+symbols+used-by (`packages/desktop/src/renderer/pages/studio/ide/codeRelations.ts` pure resolve, đọc `kgGet`); CodeLens
"editing affects N files" (emitter `ide.relations.reveal`); rail **Related code** (depends-on/used-by,
click mở file) trong FilesPane; import graph **tự rescan im lặng khi save** (debounce 1.5s) +
`ide.kg-refresh-file` patch symbols 1 file (deterministic, no-LLM) khi edit. i18n `ide.contextMenu.{run
InTerminal,openTerminalHere,runNoCommands}` + `ide.relations.*` (9 locale). Quyết định: auto-LSP binary
chỉ adopt-PATH (không tải nặng) = đánh đổi có chủ đích; re-summary semantic vẫn manual (tránh tốn token),
chỉ symbols/structural auto. Diagnostics sạch, i18n in-sync, tsc 0 lỗi mới (lỗi experience/memory/db tồn
tại là từ module khác). Xem `.kiro/status.md`.
**Cập nhật 2026-06-09 (ExpBase / Exp Graph — bộ nhớ kinh nghiệm debug cho agent):** thêm một lớp
memory chuyên cho kinh nghiệm sửa lỗi: mỗi lần fix bug khó thành công hoặc mắc sai lầm, agent ghi lại
(triệu chứng / cách fix / bối cảnh / type / bài học) thành `ExperienceEntry`, lập chỉ mục để truy hồi
khi gặp bug tương tự. Kiến trúc **lai** (người dùng duyệt): engine TS sở hữu embedding+store, MTUI là
mặt gọi 0-token cho agent. Engine `packages/desktop/src/process/experience/` (9 file, main process,
không DOM): `experienceTypes`, `experienceText` (redact secret + embeddingText tất định + lexical soup

- verificationStrength, pure), `experienceStore` (JSON theo entry, atomic, inject fs, mẫu
  `company/memoryStore`), `experienceVectorIndex` (normalize/cosine + embed wrapper, embedding OPTIONAL →
  degrade lexical), `experienceCapture` (normalize+sanitize+dedupe lexical Jaccard≥0.82+merge),
  `experienceRetrieval` (rank 0.5*semantic-or-lexical+0.22*contextMatch+0.1*confidence+0.1*verification+
  0.08*recency−penalty), `experienceProjection` (ghi `.mtui/exp/index.json` + hàng đợi `inbox.jsonl`/
  `forget.jsonl`), `index` (`createExperienceService` facade + `projectIdFromRoot`), `experienceBridge`
  (IPC `experience.{record,search,drain,forget}` wire ở `initAllBridges()`; `search` drain inbox+forget →
  rebuild → rank, khép vòng capture→index→retrieve; embedder best-effort qua `createDefaultEmbedder`).
  **MTUI Rust** `packages/mtui/src/exp/mod.rs` + cli `Exp` + dispatch: `mtui exp search/add/get/list/
forget` AI-free — đọc projection rank lexical+metadata mirror TS, `add`→inbox, `forget`→forget queue +
  patch index `archived`. Trigger CÓ ĐIỀU KIỆN (agent gọi `mtui exp search` khi bug khó, không inject mỗi
  query → tiết kiệm token). **Phase 2** `workflow/experienceTrigger` (fail/signature, ngưỡng 2 hoặc hard) +
  `workflow/experienceWorkflow` (onVerifyOutcome/captureSuccess/captureFailure/recordFeedback) + confidence
  tuning. **Phase 3** `workflow/experienceGraph` (relations same_symptom_as/same_root_cause/contradicts/
  applies_to + enrichSuggestions). **Phase 4** `workflow/experienceMetrics` + IDE mode **ExpBase** (icon
  Brain, `renderer/pages/studio/ide/expbase/`, wire IdeWorkspace) search/browse/feedback/archive/metrics;
  bridge `experience.{record,search,drain,forget,feedback,metrics,list,verify-outcome}`, IPC contract ở
  `packages/desktop/src/process/experience/experienceTypes.ts` (renderer-safe). Test: TS `tests/unit/experience/` 102 (workflow + DOM), Rust
  `cargo test exp::` 5/5, ide 340 pass không hồi quy, i18n 9 locale. Spec `.aionui/specs/exp-graph/`. Xem
  `.kiro/status.md`.
  **Cập nhật 2026-06-09 (IDE session super-memory — trí nhớ ephemeral cho agent ở IDE):** thêm một
  "super-memory" sống-trong-RAM, scoped theo phiên chat IDE (1 tab = 1 conversation). Lõi pure
  `packages/desktop/src/process/ide/memory/sessionMemoryStore.ts` (`createSessionMemoryStore` DI summarizer/clock/estimator;
  singleton `getSessionMemoryStore` dùng `heuristicSummarizer` không cần model): note có kind+pinned,
  secrets session-only (API key), forced compaction inline khi vượt `tokenBudget` (fold note cũ nhất trừ
  pinned + `keepRecent` → 1 summary, loop-guard), `clearSession` xóa hẳn khi đóng tab (KHÔNG ghi đĩa —
  ngược với company `memoryStore`). Agent dùng qua IDE MCP `aionui-ide`: tool `ide_memory_remember`/
  `ide_memory_recall`/`ide_memory_forget`/`ide_memory_set_secret`/`ide_memory_status` (gate
  `IdeServerDeps.memory?`, wire ở `ideMcpWiring.buildIdeServer`). sessionId = `memId` (`ide-mem-<uuid>`)
  sinh mỗi tab, nhúng vào primer qua `superGuidance.buildIdeMemoryRules`/`withIdeMemoryRules`; `useIdeChat`
  persist {id,memId} (tương thích legacy string[]), clear memory khi `close` tab. Renderer-facing bridge
  `packages/desktop/src/process/ide/memory/ideMemoryBridge.ts` (kênh `ide.memory-snapshot`/`ide.memory-clear`, đăng ký ở
  `initAllBridges()`) + `ideClient.memorySnapshot/memoryClear`. **Production-grade (giảm token/tăng tốc/
  rộng recall, KHÔNG vector DB/model/network):** dedup-consolidate khi ghi (Jaccard ≥0.82 hoặc containment
  ≥0.9 superset → update note cũ giữ text dài hơn + bump access, không append trùng), salience-based
  eviction (fold note ít accessCount+recency nhất; pinned bất khả xâm phạm), recall token-bounded
  (`recallTokenBudget` 1500) + xếp hạng theo query/salience trả kèm `tokens`, estimator đếm
  word+CJK thay chars/4, concurrency-safe (serialize `remember` per-session), guard note/secret quá khổ.
  **Semantic recall (offline, 0-dep):** `packages/desktop/src/process/ide/memory/embedding.ts` (`createLocalEmbedder`
  feature-hashing bag-of-n-grams 256-chiều L2-norm + `cosineSimilarity`, deterministic, không model/network)
  inject qua `SessionMemoryStoreOptions.embedder?`; `recall` xếp hạng theo cosine (ngưỡng 0.12 + phrase
  bonus) khi có embedder, fallback lexical khi không — bắt sub-word ("auth"↔"authentication"). Hybrid
  score (cosine + overlap + phrase), meta-summary (fold summary cũ khi phiên cực dài), pinned cap
  (maxPinned 32 tự bỏ ghim cũ). **UI**:
  `renderer/pages/studio/ide/memory/` (`useIdeMemory` poll snapshot + `packages/desktop/src/renderer/pages/studio/ide/memory/MemorySessionDrawer.tsx` Arco Drawer:
  gauge token, stat counters, note list nhóm, secret keys chỉ tên, Clear/Refresh) — nút "Memory" ở tab
  strip `IdeChatPanel` mở drawer theo `memId` tab active. i18n `ide.memory.*`đủ 9 locale. Test`tests/unit/ide/memory/`(store + embedding + DOM drawer) → toàn bộ`tests/unit/ide`347+ pass; oxlint
0/0; getDiagnostics sạch mọi file phạm vi. Xem`.kiro/status.md`.
**Cập nhật 2026-06-06 (LSP execution layer — IDE code-aware không cần agent):** bổ sung lớp thực thi
LSP tải-theo-yêu-cầu (KHÔNG bundle, chỉ tải khi người dùng opt-in). Backend `process/ide/lang/`:
`lspProtocol`(PURE JSON-RPC over stdio codec),`lspConvert`(PURE WorkspaceEdit/TextEdit/
DocumentSymbol → 1-based),`lspInstallManager`(npm tải thật`typescript-language-server`/`pyright`vào`<userData>/lsp/`; binary `rust-analyzer`/`gopls`/`clangd`adopt-PATH hoặc needs-manual — không
hardcode URL),`lspRuntime`(spawn + handshake + completion/hover/definition/references/rename/format/
documentSymbols/signatureHelp),`ideLspBridge`(kênh`ide.lsp-_`+ diagnostics emitter). Renderer:`packages/desktop/src/renderer/pages/studio/ide/lspClient.ts`, `packages/desktop/src/renderer/pages/editor/adapters/monacoLspProvider.ts`(nối Monaco providers + markers),`TextCodeAdapter`attach khi server đã cài,`components/LspServersPanel`+ mode`lsp`(icon Puzzle)
opt-in dựa trên`mtui analyze type`. i18n `ide.lsp._`9 locale. Test`tests/unit/ide/lang/`lspProtocol+lspConvert 24/24. **MTUI**: rebuild release để có lệnh`analyze type`(binary cũ thiếu).
**Cập nhật 2026-06-02 (Studio Editor AI — thay "AI yếu" bằng chat thật + Office-edit MCP):** giải
quyết phản hồi người dùng "phần AI của editor ngơ ngơ, chat không giống chat trang chính". **Lớp 1
(chat giống trang chính):**`packages/desktop/src/renderer/pages/studio/components/DocAssistantPanel.tsx`VIẾT LẠI — bỏ engine tự viết
(single-shot completion + vòng ReAct JSON tự parse), embed thẳng`<ChatConversation>`(component chat
chính) qua hook mới`packages/desktop/src/renderer/pages/studio/hooks/useDocChat.ts`(MỘT conversation thật/ file, pin`extra.workspace`= thư mục
chứa file, persist convId theo filePath ở localStorage, restore/prune khi mở lại) + picker CLI agents/
preset assistants (giống`IdeChatPanel`). **Lớp 2 (Office-edit MCP `aionui-office-editor`):** MCP server
in-process SSE (mirror `aionui-automation`) 13 tool `office\**`(read/search_replace/replace_passage/
insert/append/replace_all/apply_headings/insert_toc/format_text/format_passage/insert_table/set_cells/
run_api). Vì ONLYOFFICE chạy ở renderer còn MCP ở Main, thêm **RPC Main→Renderer** qua bridge đối xứng:`packages/desktop/src/process/editor/editorToolsBridge.ts`(contract kênh`editor-tools.run`), renderer ĐĂNG KÝ provider
`packages/desktop/src/renderer/pages/studio/editorToolsProvider.ts`(dispatch qua`docAgentTools.parseAction`+`runTool`lên`onlyOfficeConnector`, mount 1 lần ở `StudioPage`qua`useEditorToolsProvider`), Main INVOKE qua
`packages/desktop/src/process/editor/editorToolsClient.ts`(timeout-guard → not-ready khi chưa mở Office). Server+host+wiring:`packages/desktop/src/process/resources/builtinMcp/officeEditorServer.ts`, `packages/desktop/src/process/editor/officeEditorMcpHost.ts`/
`packages/desktop/src/process/editor/officeEditorMcpWiring.ts`/`packages/desktop/src/process/editor/registerOfficeEditorMcp.ts`; đăng ký ở `packages/desktop/src/process/utils/runBackendMigrations.ts`
(`ensureOfficeEditorMcpRegistered`, catalog `enabled:false`). `useDocChat`tự attach Office MCP vào`selected*session_mcp_servers`+ nhồi rules`packages/desktop/src/renderer/pages/studio/hooks/officeEditorGuidance.ts`(nhúng filePath) khi tạo chat.
Xóa file chết:`useDocAssistant`/`useDocAgent`/`docAgentStore`/`extractCodeBlock`/`useDocAgentActivity`;
`SiderStudioEntry`bỏ green-dot. i18n: thay block`studio.assistant.\*` (9 locale, bỏ key cũ, +`newChat/
  > startHint/startChat/loading/noAgents/cliGroup/presetGroup`) + thêm `studio.create.pickModel`. tsc EXIT=0,
`tests/unit/studio`31/31 +`tests/unit/editor/officeEditorServer`8 +`officeEditorGuidance`8, i18n PASS.
Xem`.kiro/status.md` callout "Studio Editor AI".
báo nhiều lần "không tóm tắt được video YouTube" (`solver script (deno) were skipped`, `track empty`,
`innertube 400`). Root cause (đã xác minh chạy tay): yt-dlp 2026+ cần **yt-dlp-ejs** (script giải
JS-challenge của YouTube) tải qua `--remote-components ejs:github`; Deno chỉ là runtime CHẠY script.
Thiếu cờ này thì web client trả caption rỗng. Đã thêm `--remote-components ejs:github`vào`packages/desktop/src/process/services/contentExtract/ytDlpTranscript.ts`+ nhận diện lỗi`solverSkipped`(báo "JS-challenge
solver unavailable" thay vì gán nhầm "429"). Test tay 1 video → EXITCODE=0, ghi file`.en.json3`.
Yêu cầu runtime: **Deno** (`~/.deno/bin`) + mạng tới `github.com/yt-dlp/ejs/releases`(cache sau lần
đầu). Test`tests/unit/contentExtract/`22/22. Cần`bun start`lại để nạp build mới. Xem`.kiro/status.md`.
**Cập nhật 2026-06-02 (Cải thiện IDE — đợt 2: Diagnostics inline + Go-to-definition/References):** thêm
**Diagnostics inline** (`process/ide/lint/`: `lintParse`pure parse oxlint`--format unix`+`ideLintBridge`kênh`ide.lint-file`chạy oxlint per-file;`TextCodeAdapter`vẽ`monaco.editor.setModelMarkers` debounce
700ms). **Go-to-def/refs** (`process/ide/nav/`: `symbolNav`pure regex declaration/reference +`ideNavBridge`kênh`ide.find-definition`/`ide.find-references`walk repo; editor F12/Shift+F12 → emitter`ide.nav.request`→ IdeWorkspace nhảy thẳng nếu 1 def, hoặc mở`NavResultsPanel`). KG stale auto-rebuild = Live mode đã có
sẵn. Run-test-at-line hoãn. Test `tests/unit/ide/` 215/215, tsc sạch, i18n 9 locale (`ide.nav._`). Đều
heuristic (oxlint cho lint, regex cho nav) — rẻ, on-demand, không cần LSP/tsc-per-file.
**Cập nhật 2026-06-02 (Cải thiện IDE — đợt 1: Agent Hooks + Search&Replace + Command Palette):** thêm
**IDE Agent Hooks** (`process/ide/hooks/`+`renderer/pages/studio/ide/hooks/`+`components/IdeHooksPanel`):
tự động hóa agent theo sự kiện file (lưu/tạo/xóa/thủ công) → gọi agent prompt hoặc chạy lệnh shell,
per-workspace, mode mới ⚡ trong activity bar. **Search & Replace** toàn repo: `process/ide/search/`
(`grepCore`pure +`ideSearchBridge`kênh`ide.grep`/`ide.replace-file` — trước đây SearchPanel luôn
"unavailable" vì kênh chưa tồn tại). **Command Palette** (`palette/`): Ctrl/Cmd+P mở file fuzzy,
Ctrl/Cmd+Shift+P chạy lệnh. Multi-tab terminal đã có sẵn trong IdeTerminalPanel. Test `tests/unit/ide/`191/191, tsc sạch, i18n 9 locale. Wire bridge ở`initAllBridges()`. Còn lại (diagnostics inline,
go-to-def, đa-root) hoãn vì lớn/rủi ro — xem `.kiro/status.md`.
**Cập nhật 2026-06-02 (9Router — lớp tích hợp provider + connector phân phối, GĐ1):** thêm 9Router
như một provider preset trong Settings › Model (`packages/desktop/src/renderer/utils/model/modelPlatforms.ts`: value
`9router`, platform `custom`, base_url `http://127.0.0.1:20128/v1`, i18nKey `settings.platform9router`)
  > → người dùng chọn 9Router + nhập key dashboard → auto-import model list qua `GET /v1/models` (tái dùng
  > `useModeModeList`). Thêm module **pure** `common/router9/` (4 file: `types.ts`/`packages/desktop/src/common/router9/targets.ts`/
  > `packages/desktop/src/common/router9/connectorEngine.ts`/`index.ts`) — engine `buildConnectorPlan(targetId, endpoint)` tính \_plan_ cấu hình
  > đúng định dạng cho từng CLI/IDE đích (kiro/antigravity/claude-code/codex/cursor/cline/openclaw): env
  > vars (Codex), config file deep-merge (Claude Code `.gemini/config.json`, OpenClaw
  > `~/.openclaw/openclaw.json`), hoặc copy-paste fields (manual). Không side effect — applier ghi file thật
  > để GĐ sau. Kiến trúc: **companion/explicit-proxy**, KHÔNG nhúng router vào aioncore, KHÔNG mitm TLS;
  > dịch định dạng do 9router lo. i18n `settings.platform9router` + `settings.router9.*` (9 locale). UI:
  > panel **"Distribute via 9Router"** (`packages/desktop/src/renderer/pages/settings/router9/Router9ConnectorPanel.tsx`) render
  > cuối `ModelModalContent` — chọn target + endpoint/key/model → hiện copy-paste fields + env block + nội
  > dung config file, mỗi khối có nút Copy (clipboard). Side-effect-free: chỉ tính plan + copy, applier ghi
  > file thật để GĐ sau. Test `tests/unit/router9/connectorEngine.test.ts` 12/12, getDiagnostics sạch,
  > i18n PASS. Xem `.kiro/status.md` callout "9Router".
  >
  > **Cập nhật 2026-06-03 (9Router — GĐ2: nút Apply ghi config tự động):** hoàn thiện "applier" để panel
  > "Distribute via 9Router" KHÔNG chỉ copy-paste mà ghi config thật một-chạm (renderer + Main, KHÔNG đụng
  > aioncore/Rust). Thêm `packages/desktop/src/common/router9/applyPlan.ts` (PURE: `expandHome`/`deepMerge`/`mergeConfigContent`
  > — JSON deep-merge incoming-thắng, không mutate, existing JSON hỏng thì throw để không mất file),
  > `packages/desktop/src/process/router9/router9Applier.ts` (`applyConnectorPlan` recompute plan ở Main + ghi atomic tmp→rename
  >
  > - backup `.bak` timestamp trước khi đè; env-target trả `notes`; fs seam DI), `packages/desktop/src/process/router9/router9Bridge.ts` (kênh
  >   `router9.apply-plan` always-resolve, wire ở `initAllBridges()`), renderer `packages/desktop/src/renderer/pages/settings/router9/router9BridgeClient.ts`
  >   (timeout-guard 15s). `Router9ConnectorPanel` thêm nút **Apply** (ẩn với target `manual`) + khối kết quả
  >   (đã ghi/giữ file, báo backup, env note). i18n +8 key `settings.router9.{apply,applyHint,applied,
applyFailed,fileWritten,fileSkipped,backupSaved,envNote}` (9 locale). Test `tests/unit/router9/` **28/28**
  >   (engine 12 + applyPlan 10 + applier 6), tsc không lỗi mới ở router9, i18n PASS. **Bối cảnh điều tra:**
  >   freemodel.dev chỉ phục vụ claude qua Claude Code CLI (gọi HTTP thường trả "Please use Claude Code CLI",
  >   stream nuốt nội dung) → cách dùng đúng là cấu hình Claude Code (CLI agent) trỏ 9Router, nay làm được
  >   bằng 1 nút. Xem `.kiro/status.md` callout "9Router connector — Apply".
  >
  > **Cập nhật 2026-06-02 (Testing → phát hiện app: thêm thiết lập thủ công + thanh tiến trình AI):** trang
  > Testing (`renderer/pages/testing/`) thêm 2 tính năng cho bước chọn folder. (1) **Thiết lập thủ công** —
  > nút mới `testing.form.manualSetup` trong `NewSessionPanel`: chọn folder rồi tự nhập URL/command/services
  > qua `AppUnderTestEditor` (mở sẵn advanced, seed `cwd`), KHÔNG gọi model — dùng khi chưa cấu hình model
  > hoặc AI đoán sai. (2) **Thanh tiến trình AI** — `appDetector.detect()` nhận `onProgress` phát
  > `DetectProgress` (phase `scanning|reading|analyzing|parsing|cache|done|error`, kèm tên file đang đọc);
  > `testingBridge` bơm qua emitter mới `testing.detect-progress`; `useTestingState.onDetectProgress` hứng và
  > render component mới `DetectProgressBar` (Arco `Progress` + icon `@icon-park/react` + token UnoCSS) để thấy
  > AI đang đọc/làm gì thay vì spinner trống. i18n: +`testing.form.manualSetup/manualReady` +
  > `testing.detect.phase_*` (9 locale, reference en-US). getDiagnostics sạch, test `tests/unit/testing/` 59/59,
  > i18n:types + check-i18n pass.
  > **Cập nhật 2026-06-02 (Manager → Notes: theo theme chung + font tiếng Việt):** sửa 2 điểm người dùng báo.
  > (1) **Background theo theme**: `packages/desktop/src/renderer/pages/manager/manager.module.css` `.root` trước ghim palette "paper" trắng + override
  > token Arco/app → ép workspace always-light. Nay remap alias Notion (`--paper/--ink/--line/--canvas`) sang
  > token theme toàn cục (`--bg-base/--bg-1/--bg-2/--text-primary/--border-base`), bỏ override `--color-*`
  > cứng → Notes (và cả Manager) theo light/dark chung. BlockNote `theme` follow `data-theme` qua
  > `useEditorScheme` (observe attribute + media query). (2) **Font hỗ trợ tiếng Việt**: `packages/desktop/src/renderer/pages/manager/components/appearance.ts`
  > `FONT_STACK` bỏ `'Inter'` dẫn đầu → system stack (`system-ui`+`Segoe UI/Roboto/Noto Sans/PingFang...`);
  > bỏ import `@blocknote/core/fonts/inter.css` (editor inherit font app). tsc/manager test (84) sạch.
  >
  > **Cập nhật 2026-06-02 (Agent detection — Kiro CLI không hiện do tên binary lệch):** làm rõ cơ chế
  > detect + fix tại máy. aioncore giữ CATALOG tĩnh các agent (mỗi entry có `agent_source_info.binary_name`)
  > và resolve tên đó trên `$PATH` (`available` nếu thấy). Kiro ĐÃ có sẵn trong catalog (`backend=kiro`)
  > nhưng probe binary `kiro-cli-chat`, trong khi bản cài tên `kiro-cli` → báo `missing`. Fix không đụng
  > Rust: tạo shim `kiro-cli-chat.cmd` trên PATH forward `kiro-cli %*`. Verify bằng `aioncore.exe doctor`
  > (subcommand self-check in bảng availability) + `GET /api/agents` thật (Kiro `available:true` +
  > handshake ACP `kiro-cli acp`). Thêm mục giải thích vào Section "Agent Detection" (binary*name probing +
  > `doctor`). Chi tiết: `.kiro/status.md` callout "Kiro CLI không được app detect".
  > **Cập nhật 2026-06-02 (Manager → Notes: editor full-page kiểu Notion cho mọi loại note):** thống nhất
  > trải nghiệm viết note (Daily/Learn/Data) sang một editor full-page kiểu Notion thay cho các modal cũ.
  > Mới: `notes/editor/NotePageEditor` (overlay full-surface, tạo note lười + bỏ nếu để trống, Esc/Back để
  > đóng, convert-to-task, delete), `notes/editor/NoteProperties` (hàng thuộc tính inline: tags + link
  > task/event; Data thêm URL/file + nút mở nguồn + AI summarize), `notes/editor/LearnLinksFooter`
  > (outgoing/backlink bàn phím-accessible). `NotePage` thêm slot `toolbar`/`properties` + prop `bodyVersion`
  > (ép re-parse sau AI fill). `useManagerStore` thêm `mutate()` trả document mới. **Fix bug:** Data mở nguồn
  > file path qua `ipcBridge.shell.openFile` (trước đây bấm không làm gì), URL qua `openExternalUrl` (không
  > `window.open`). Bỏ `NoteEditor`/`DataEntryEditor` (modal) + `linking/{WikiTextArea,WikiMarkdown}` (orphan;
  > wiki-link giữ qua footer + graph). a11y: list Learn + link rows + data source row có role/tabindex/Enter-Space.
  > Test mới `tests/unit/manager/NoteProperties.dom.test.tsx` (3) — manager 84/84 pass; i18n 9 locale +3 key
  > (`notes.back`, `notes.data.open`, `notes.data.openFailed`); tsc sạch ở mọi file manager.
  > **Cập nhật 2026-06-02 (Git Manager — trình quản lý Git/GitHub thật, NẰM TRONG IDE — mode `git` của
  > activity bar IDE, không phải Settings):** push/pull/clone repo GitHub thật như một trình quản lý.
  > **Backend `process/git/` (6 file):** `gitTypes` (type renderer-safe), `gitCredentialStore` (lưu
  > Personal Access Token **mã hóa qua Electron `safeStorage`**, renderer chỉ thấy 4 ký tự cuối, token
  > giải mã CHỈ ở Main), `gitRepoStore` (CRUD repo đăng ký, `git-repos.json` atomic), `gitRunner` (git
  > thật qua child_process: clone/status/changes/log/commitAll/push/pull/initAndSetRemote; **auth không lộ
  > token** qua `-c http.extraheader=Authorization: Basic <base64>` one-shot + `redact()` xóa token mọi
  > shape; `GIT_TERMINAL_PROMPT=0` fail-fast), `gitManagerBridge` (kênh `gitmgr.*`always-resolve + emitter
repos-changed),`gitManagerWiring`. Wire ở `initAllBridges()`. **Renderer `renderer/pages/git/`:**
`gitManagerClient`(timeout guard 6s/180s),`useGitManager`, `GitPage`(rail repos + detail),`components/`(RepoList/RepoDetail/RegisterRepoModal/CredentialsModal). **Render trong`packages/desktop/src/renderer/pages/studio/ide/IdeWorkspace.tsx`mode`git`**
(thay GitPanel cũ). Register repo = điền URL + chọn folder + branch + credential + clone-now; detail có
commit box + Pull(down)/Push(up)/Clone + **confirm khi push lên main/master**. i18n module `git`9 locale.
Files mode IDE vẫn có diff-review banner riêng (useRepoChanges) cho folder đang mở. tsc sạch.
**Cập nhật 2026-06-02 (Terminal lên chuẩn VS Code — xterm.js + node-pty):** thay engine + render
terminal để ngang VS Code. **Backend:** thêm`packages/desktop/src/process/terminal/nodePtyBackend.ts`
(`createNodePtyBackend`/`tryCreateNodePtyBackend`) — pty THẬT qua `node-pty`(ConPTY/forkpty):`isatty`,
resize thật, signals, TUI (vim/htop) đúng. Cùng `IPtyBackend`nên KHÔNG đổi`terminalManager`;
`terminalWiring`dùng node-pty mặc định, fallback`child_process`nếu native load lỗi. node-pty 1.1.0
dùng prebuild N-API (không cần rebuild theo Electron); electron-builder.yml đã có sẵn cấu hình
files/vendor/asarUnpack cho nó. **Render:** viết lại`packages/desktop/src/renderer/pages/terminal/components/TerminalView.tsx`bằng`@xterm/xterm`+ addon`fit`/`search`/`web-links`/`webgl`→ char-mode input (Tab-complete/mũi tên/Ctrl-\*), full TTY
emulation, virtualized (hết lag), resize chính xác qua FitAddon →`terminalClient.resize`. Theme khớp
semantic token qua `packages/desktop/src/renderer/pages/terminal/components/xtermTheme.ts`(live-update theo`data-theme`/`prefers-color-scheme`).
`useTerminalState`thêm`resizeSession`. Console tab vẫn dùng `normalizeOutputRich` (viewer read-only).
Deps root: +`@xterm/xterm`+4 addon, +`node-pty@1.1.0`(tường minh). Test terminal **36/36** (cập nhật
case scrollback của`TerminalPage.dom` sang assert replay-qua-bridge vì xterm render vào canvas). tsc
  > không lỗi mới ở file terminal. \*(Quyết định cũ "KHÔNG node-pty/xterm để giữ zero-dep" bên dưới đã bị
  > thay thế: binary node-pty có sẵn + builder đã cấu hình → rủi ro thấp, đổi lấy fidelity ngang VS Code.)\_
  >
  > **Cập nhật 2026-06-01 (Terminal manager — Settings › Terminal, Giai đoạn 1+2):** thêm chức năng
  > quản lý Terminal tích hợp ("một app cho tất cả") ở `/settings/terminal` (desktop-only). Ba khả năng:
  > **(1) Session app quản lý** — shell tương tác thật (gõ lệnh → nhận output), tạo/tắt/xóa, đếm số
  > đang chạy; **(2) System (read-only)** — đếm + liệt kê tiến trình shell của OS (`tasklist`/`ps`),
  > KHÔNG tương tác (chỉ quan sát); **(3) Schedules** — cài lịch chạy script vào session mới theo cron
  > (vd mở `9router` mỗi sáng), dựa trên `croner`.
  >
  > **Giai đoạn 3 (IDE Terminal panel) — DONE:** `IdeTerminalPanel` nhúng vào đáy `IdeWorkspace` như
  > bottom dock của mọi IDE chuyên nghiệp. Hai tab: **Terminal** (shell tương tác, chip strip chuyển
  > session, terminal mới mở với `cwd` = thư mục dự án đang mở) + **Console** (xem output read-only của
  > bất kỳ session nào — tiện theo dõi script dài như `9router`). Dock có thể kéo resize (160–560px),
  > thu gọn thành thanh mỏng 38px hiện badge số session đang chạy. Tái dùng 100% `useTerminalState` +
  > `TerminalView` từ Settings › Terminal — cùng backend, cùng session registry. i18n `ide.terminal.*`
  > thêm vào 9 locale `ide.json`. getDiagnostics sạch, tsc không lỗi mới.
  >
  > **Quyết định kiến trúc quan trọng:** engine PTY dùng **`node:child_process` thuần, KHÔNG thêm
  > `node-pty`** (tránh native module + rebuild rủi ro). Trừu tượng hoá qua `IPtyBackend` để swap sang
  > `node-pty` sau mà không đổi manager/UI. Đánh đổi: không có TTY thật (full-screen curses như vim/htop
  > có thể khác), nhưng đủ cho chạy lệnh + mở tool dài hạn. UI render bằng view tự viết (Arco
  > `Input.TextArea` + scrollback strip-ANSI), KHÔNG thêm `xterm` (giữ zero-dep). Lịch chỉ chạy khi app
  > mở, local-only, không expose qua kênh remote.
  >
  > **Backend** `process/terminal/` (9 file): `terminalTypes` (type renderer-safe), `ptyBackend`
  > (`IPtyBackend` + child_process FALLBACK backend + `resolveDefaultShell`), `nodePtyBackend` (pty THẬT
  > qua node-pty — DEFAULT), `terminalManager` (registry session
  >
  > - scrollback bounded 200k + event `data`/`exit`/`sessions-changed` + `runningCount`), `systemProcesses`
  >   (`parseTasklistCsv`/`parsePsOutput` + `listSystemTerminals` degrade-safe), `terminalScheduleStore`
  >   (CRUD atomic tmp+rename, `userData/terminal-schedules.json`), `terminalScheduler` (arm cron/once qua
  >   croner, fire = create session + write script), `terminalBridge` (kênh `terminal.*` envelope
  >   always-resolve + emitter push), `terminalWiring` (`getTerminalServices`). Wire ở `initAllBridges()`
  >   (block try/catch riêng, `scheduler.start()` arm lịch ngay). **Renderer** `renderer/pages/terminal/`:
  >   `terminalBridgeClient` (timeout-guard, rebuild invoker từ tên kênh, chỉ `import type`), `constants`
  >   (`stripAnsi`/`normalizeOutput` + `ScheduleDraft`), `useTerminalState` (load + live subscribe, buffer
  >   per-session, degrade `unavailable`), `TerminalPage` (3 tab + header running-count), `index` (wrap
  >   SettingsPageWrapper), `components/` (BridgeNotice, SessionList, TerminalView [xterm.js], xtermTheme,
  >   SystemProcessPanel,
  >   SchedulePanel, ScheduleEditor). Route `/settings/terminal` + nav `SettingsSider` (icon `Terminal`,
  >   sau `monitor`, desktop-only). i18n module `terminal` (9 locale). Test `tests/unit/terminal/` **36/36**
  >   (manager 7, systemProcesses 6, scheduler 5, scheduleStore 7, constants.dom 7, TerminalPage.dom 5),
  >   tsc các file terminal sạch, i18n PASS. **Giai đoạn 3 (chưa làm):** nhúng panel Terminal + Console
  >   vào Studio IDE (tái dùng `terminalClient`/`useTerminalState`).

> **Cập nhật 2026-06-01 (Omni IDE Phase 1+2 — Context Builder + Quick Test Tracer):**
> **(Phase 1)** `packages/desktop/src/process/ide/graphSnapshot.ts` diff 2 KG snapshot theo thời gian (commitHash+fingerprint, pure);
> `packages/desktop/src/process/ide/contextBuilder.ts` lõi "agent hiểu code" — lexical+graph ranker (DI, vector sau), graph-expand 1 hop,
> changed-boost từ diff, trim theo symbol → context pack gọn; `packages/desktop/src/process/ide/rulesLoader.ts` đọc `.aionrules`/`AGENTS.md`/
> `.cursorrules`; `useIdeChat.open` tự inject rules+context pack vào `preset_context` khi mở tab (ngầm, < 1s).
> Kênh `ide.kg-diff`/`ide.kg-context`/`ide.rules-load`.
> **(Phase 2)** `packages/desktop/src/process/ide/quickTestTracer.ts` CDP attach/detach ghi trace (click/input/network/console/exception/navigate)
> khi user tự thao tác app; `packages/desktop/src/process/ide/quickTestBuffer.ts` PURE smart-eviction (giữ error+interaction path khi log ồn);
> `packages/desktop/src/process/ide/traceContextBuilder.ts` map trace → ContextPack (stack URL→node, network→api/service, selector→UI component);
> `packages/desktop/src/process/ide/quickTestBridge.ts` kênh `ide.qt-start/-stop/-event` push-stream event significant qua `onEvent` (không polling).
> Chi tiết hoàn thiện: xem `docs/session/ide/`.

> **Cập nhật 2026-06-01 (IDE Understand — incremental/realtime/C4):** nâng cấp mode **Understand**
> trong Studio › IDE (bản port Understand-Anything của Lum1104, MIT) theo 4 hướng người dùng yêu cầu:
> **(1) Fallback summary** — `knowledgeGraphBuilder.fallbackSummary()` sinh tóm tắt tất định từ
> tên+layer+symbols+importedBy cho mọi file LLM chưa kịp phân tích (gắn `KnowledgeNode.summarySource`
> = `'llm' | 'fallback'`), không còn ô tóm tắt trống; UI badge "auto" ở `NodeDetailRail`.
> **(2) Ghi nhớ + tái dùng (incremental)** — `fingerprintOf()` hash nội dung pure (FNV-1a, KHÔNG
> node:crypto để builder vẫn testable); `KnowledgeBuildOptions.previous` cho phép reuse verbatim node
> nào fingerprint trùng + đã có summary LLM (bỏ qua gọi model), chỉ phân tích file mới/đổi; tours +
> overview cũng carry-over khi không có target mới. Bridge `kg-build` tự load graph cũ làm `previous`.
> Schema graph lên **v2** (thêm `fingerprint`/`summarySource`/`externals`).
> **(3) Realtime** — `packages/desktop/src/process/ide/repoWatcher.ts` (DI `fs.watch` recursive + debounce 800ms, lọc ext
>
> - bỏ vendor dirs); kênh `ide.kg-watch-start`/`ide.kg-watch-stop` + emitter `ide.kg-changed`; hook
>   `useUnderstand.setLive(on, model)` **opt-in** (mặc định off), auto-rebuild incremental debounce 1200ms
>   khi file đổi, kèm diff-impact highlight.
>   **(4) C4 + diff + view** — `packages/desktop/src/renderer/pages/studio/ide/graphModel.ts` PURE: `deriveC4(graph, level)`
>   chiếu graph sang 4 cấp **Context/Container/Component/Code** (Simon Brown C4) tính client-side từ
>   nodes/edges/modules/externals; `computeImpact(edges, changedIds)` + `liftChangedToView` cho diff
>   ripple. `packages/desktop/src/renderer/pages/studio/ide/components/C4GraphView.tsx` render mọi cấp với layout **Columns | Force** (radial deterministic, KHÔNG
>   3D) + overlay changed(vàng)/impacted(ring). `packages/desktop/src/renderer/pages/studio/ide/components/OverviewPanel.tsx` là tab mặc định sau build
>   (overview-first: tagline/description/tech/entry-points/tours — "graphs that teach"). `extractExternals`
>   (repoGraph) rank package import cho Context level; `extractPolyglotSymbols` thêm symbol Python/Rust/
>   Go/Java (regex coarse, KHÔNG full tree-sitter — ghi chú task tương lai). Constants layer chuyển sang
>   `packages/desktop/src/renderer/pages/studio/ide/components/layerColors.ts`. i18n 9 locale (`ide.understand.{viewMode,c4,live,layout,overview,...}`),
>   tsc toàn dự án sạch, `tests/unit/ide/` **72/72** (thêm `tests/unit/ide/graphModel.test.ts` + `tests/unit/ide/repoWatcher.test.ts`).

> **Cập nhật 2026-06-06 (Company ↔ IDE — built-in IDE MCP server, Agent plane):** nối Company role
> dùng được tính năng IDE. Trước đó các plane khác (Browser/Testing/Office/Cron/Manager) đều có
> built-in MCP server cho agent, riêng IDE plane chưa có → role không có cách chính danh dùng repo
> intelligence. Thêm thư mục mới `process/ide/mcp/`: `packages/desktop/src/process/ide/mcp/ideServer.ts` (factory + 6 tool `ide_*`:
> list_dir/read_file/search/find_definition/find_references/scan_repo), `packages/desktop/src/process/ide/mcp/ideMcpWiring.ts` (service
> fs-backed TÁI DÙNG helper thuần của IDE UI: `repoGraph`/`grepCore`/`symbolNav` → 2 plane không lệch),
> `packages/desktop/src/process/ide/mcp/ideMcpHost.ts` (in-process SSE host, mirror `cronMcpHost`), `packages/desktop/src/process/ide/mcp/registerIdeMcp.ts`
> (`ensureIdeMcpRegistered`, catalog `name=aionui-ide` builtin enabled:false opt-in). Wire bước
> `ensureIdeMcpRegistered` vào `packages/desktop/src/process/utils/runBackendMigrations.ts`. `packages/desktop/src/renderer/pages/conversation/hooks/superGuidance.ts` thêm `withIdeToolRules`;
> `companySession.applyCapabilities` augment briefing khi role được cấp `aionui-ide`. Dùng: gán
> capability MCP "aionui-ide" cho role trong Company. Verify: `tests/unit/company/`+`tests/unit/ide/`
> 357/357, test mới `tests/unit/ide/ideServer.test.ts` 7/7, tsc sạch.

> **Cập nhật 2026-06-06 (Company — quy trình hành chính BẮT BUỘC 100% + ép bằng code):** đảo ngược
> quyết định trước (workflow tùy chọn). Người dùng yêu cầu company phải là bộ máy có vai trò + chuỗi
> giao tiếp + quy trình BẮT BUỘC: agent biết mình là ai, báo cáo cho ai, giao việc cho ai, quy trình
> ra sao và buộc 100% làm theo. Sửa 5 file: `packages/desktop/src/process/company/soulTemplates.ts` + `packages/desktop/src/renderer/pages/company/pipeline/soulComposer.ts` (thêm "CHAIN OF
> COMMAND" + workflow MANDATORY cho cả 3 role), `packages/desktop/src/process/company/companyConversation.ts` + `packages/desktop/src/renderer/pages/company/pipeline/delegationPlanner.ts`
> (prompt binding, EVERY report nhận directive, manager PHẢI delegate). **Mấu chốt — ép bằng CODE:**
> `packages/desktop/src/renderer/pages/company/pipeline/roleRunner.ts` thêm `enforceDelegation()` — role có cấp dưới mà planner LLM lệch trả
> `execute`/`finish` thì code tự ép thành `delegate` giao cho TẤT CẢ direct report (mỗi report 1
> directive). Phân cấp luôn được tôn trọng bất kể model đề xuất gì; leaf vẫn execute thật. Verify:
> `tests/unit/company/` 119/119, tsc sạch.

> **Cập nhật 2026-06-06 (Company — gỡ ép quy trình nghiệp vụ, agent làm việc thật):** _(ĐÃ ĐẢO NGƯỢC bởi
> bản cập nhật ngay trên — giữ lại để tham khảo lịch sử)._ người dùng báo
> "company agent không hề hoạt động". Root cause: role bị ép cứng quy trình hành chính ở tầng
> prompt/soul (President buộc "1 chỉ thị / mỗi cấp dưới", buộc phê duyệt mọi milestone, buộc test gate;
> worker buộc xin phép) — trong chat 1-1 không có cấp dưới/sếp thật nên agent kẹt ở khâu "diễn" quy
> trình thay vì làm việc. Fix: chuyển workflow từ MỆNH LỆNH BẮT BUỘC → HƯỚNG DẪN TÙY Ý ở 4 file
> (`packages/desktop/src/process/company/soulTemplates.ts`, `packages/desktop/src/renderer/pages/company/pipeline/soulComposer.ts` +
> `packages/desktop/src/renderer/pages/company/pipeline/delegationPlanner.ts`, `packages/desktop/src/process/company/companyConversation.ts`): mặc định `execute`→`finish` (làm
> việc thật), delegate chỉ khi thật cần, approval/test/permission là tùy chọn dùng dè dặt — chỉ hỏi
> trước hành động phá hủy/không hồi phục. Permission/approval gate giữ nguyên (chỉ hết bắt buộc).
> Verify: `tests/unit/company/` 119/119 pass, tsc sạch.

> **Cập nhật 2026-06-01 (Company — delete + identity + bg progress):** sửa 3 lỗi người dùng báo.
> (1) **Xóa công ty không hiệu quả** → tạo lại cùng tên dùng cấu trúc cũ: nút X chỉ "forget" roster
> localStorage, file `company.json` + map role→conversation vẫn còn; `createFromDescription` merge
> `existing` config ⇒ giữ assignment/chủ tịch cũ. Fix: kênh `company.delete-company` (bridge + client +
> `ICompanyConfigStore.deleteCompany`, thêm `rm` vào `CompanyConfigFs`) xóa hẳn `<userData>/companies/<id>/`;
> `CompanyPicker` nút Delete (danger + Popconfirm); `useCompanyState.forgetCompany` xóa đĩa + dọn
> `github.com/VNDT1625/OmniAgentpany.roleConversations`. (2) **Agent không biết mình là ai**: `openRoleChat` cũ chỉ inject
> briefing khi assistant đã có rules, CLI bỏ qua. Fix: `buildBriefing` dùng `composeSoul` (identity +
> soul/workflow + delegation targets + rules), LUÔN set `extra.preset_context`, và gửi **primer turn**
> ("SYSTEM BRIEFING") qua `conversation.sendMessage` sau khi tạo (option `skipPrimer` để pipeline không
> double-send). (3) **Bar gen "reset" khi đổi tab về**: `generationStore` chạy ngầm thật (giây đúng)
> nhưng `GenerationProgress` reset `percent=6` lúc remount; fix seed percent từ `elapsed`
> (`1-exp(-elapsed/15s)*ceiling`) + hint "đang chạy ngầm". i18n 9 locale; test `tests/unit/company/` 117/117.

> **Cập nhật 2026-06-01 (Đợt 14 — Automation: node Agent Company):** thêm `WorkflowNodeKind`
> `action.company` để một bước workflow giao việc cho cả một công ty AI (tái dùng feature Agent
> Company sẵn có) thay vì chỉ 1 model. 3 mode: **create** (tạo công ty từ prompt qua
> `createFromDescription` + `createCompanyGenerator`), **goal** (giao mục tiêu cho Chủ tịch, engine
> `companyConversation.run` chia việc + tổng hợp summary), **tasks** (giao việc cho 1 role cụ thể qua
> `roleId`). Connector `packages/desktop/src/process/automation/connectors/companyAction.ts` (factory DI), output = companyId (create) hoặc
> summary chủ tịch (goal/tasks) → `{{input}}` bước sau. Chạy nền **auto-approve** permission gate
> (`config.autoApprove`, mặc định bật). `packages/desktop/src/process/automation/nodeExecutors.ts` +DI `company`; `automationStore` NODE_KINDS
> +1; `automationBridge` wiring `getCompanyServices()`+generator+configStore+conversation. UI:
> `nodeKindMeta` +entry (BuildingTwo), `NodeConfigForm` +form 3 mode. i18n +20 key × 9 locale. Test
> `tests/unit/automation/companyAction.test.ts` (8) → tổng automation 43/43 pass. tsc + i18n sạch.

> **Cập nhật 2026-06-01 (Đợt 16–17 — Automation: AI 2 chiều + Webhook + Credential vault):** Automation
> giờ là nền tảng AI 2 chiều. **Chiều 1** (người dùng→AI): panel "AI Designer" (`packages/desktop/src/process/automation/automationChatBridge.ts` +
> `WorkflowChatPanel`) — chat ngôn ngữ tự nhiên create/modify/explain/fix workflow, AI sinh JSON → lưu →
> hiện canvas. **Chiều 2** (AI→workflow): MCP server `aionui-automation` (`automationMcpServer/Host/Wiring` +
> `registerAutomationMcp`) với 7 tool list/get/create/run/cancel/delete/enable — agent/Claude/GPT tự dựng &
> chạy workflow qua MCP. **Webhook** (`packages/desktop/src/process/automation/webhookServer.ts`): POST loopback → chạy workflow `trigger.webhook`
> với body làm input. **Credential vault** (`packages/desktop/src/process/automation/credentialStore.ts` AES-256-GCM + `packages/desktop/src/process/automation/credentialBridge.ts` +
> `CredentialManager` UI + picker trong NodeConfigForm): token mã hóa, node nhận `credentialId` → merge
> secret lúc chạy, secret không lộ ra renderer. `action.conversation` wired thật (provider chat).
> `startWorkflowRun(id,input?)` + module-level activeRuns chia sẻ run mechanism. i18n 9 locale (block
> `chat`+`cred`). Test `tests/unit/automation/` 85/85 (9 file). Xem callout chi tiết trong `.kiro/status.md`.

> **Cập nhật 2026-06-01 (Đợt 13 — Automation: liên kết App ↔ Cloud ↔ Social + render video):** mở rộng
> Studio › Automation từ engine n8n cơ bản thành chuỗi "ra sản phẩm → lưu cloud → đăng social", giữ
> nguyên engine (linear pipeline). Thêm 6 `WorkflowNodeKind`: `action.app.makeVideo` (chạy pipeline Make
> Video, lưu vào shared `makeVideoStore`, render `.mp4` bằng `ffmpeg-static` qua `packages/desktop/src/process/automation/connectors/videoRender.ts`),
> `action.app.editor` (ghi/append file), `action.cloud.upload` (S3-compatible tự ký AWS SigV4 bằng
> `node:crypto` HOẶC WebDAV/Nextcloud), `action.email.send` (SMTP qua `nodemailer` — dep mới),
> `action.social.facebook` (Graph API v21.0 feed/photos/videos), `action.social.tiktok` (Content Posting
> API direct post). Connector ở `process/automation/connectors/` (mỗi cái 1 file, factory DI test được):
> `packages/desktop/src/process/automation/connectors/artifacts.ts` (helper + khái niệm **Artifact** `{path,mimeType,title,url}` truyền giữa node), `packages/desktop/src/process/automation/connectors/cloudUpload.ts`,
> `packages/desktop/src/process/automation/connectors/emailSend.ts`, `packages/desktop/src/process/automation/connectors/facebookPost.ts`, `packages/desktop/src/process/automation/connectors/tiktokPost.ts`, `packages/desktop/src/process/automation/connectors/appActions.ts` (makeVideo+editor), `packages/desktop/src/process/automation/connectors/videoRender.ts`.
> `packages/desktop/src/process/automation/nodeExecutors.ts` thêm DI `makeVideo`/`editor`; `packages/desktop/src/process/automation/automationStore.ts` NODE_KINDS +6; `packages/desktop/src/process/automation/automationBridge.ts`
> wiring `runScript`/`runImage` (export mới từ `makeVideoBridge`) + `videoRenderer`. UI: `packages/desktop/src/renderer/pages/studio/automation/nodeKindMeta.tsx`
> +6 entry, `packages/desktop/src/renderer/pages/studio/automation/components/NodeConfigForm.tsx` viết lại với form đầy đủ (Arco, không raw HTML). i18n `automation` +~60 key
> trên 9 locale. Test `tests/unit/automation/` (connectors 13 + videoRender 9) 35/35 pass, tsc + i18n sạch.
> Còn lại (enhancement): TTS narration trong video, OAuth UI cho FB/TikTok, scheduler thật cho `trigger.schedule`.

> **Cập nhật 2026-06-01 (Content-extraction service chung — transcript yt-dlp + markitdown):** thêm
> module `process/services/contentExtract/` (`externalTools` dò yt-dlp/uvx + cache; `ytDlpTranscript`
> tầng-1 transcript parse VTT/SRT/JSON3; `fileToMarkdown` `uvx markitdown`→Node fallback mammoth/
> officeparser/turndown; `contentExtractService` facade `extract({kind:youtube|file|html|auto})` —
> YouTube tiered yt-dlp→anonymous fetcher cũ). API dùng chung: Browser web-agent `fetchTranscript`,
> Manager `docExtractor`, và tool MCP agent-plane `extract_content` trong `browserControlServer`. Không
> bundle/không thêm npm dep nặng — yt-dlp/markitdown là công cụ ngoài resolve lúc chạy, degrade an toàn
> về Node. Test `tests/unit/contentExtract/` 22/22, tsc EXIT=0.

> **Cập nhật 2026-06-01 (Browser web-agent chạy ngầm khi rời trang):** sửa lỗi người dùng báo
> "trình duyệt chỉ sống trong tab đó, qua tab khác là ngừng". Root cause: transcript + cờ running của
> web-agent sống trong React state `useAgentChat`, subscription `onAgentEvent` bị huỷ khi trang Browser
> unmount → rời trang là mất transcript/ngừng nghe (runner Main vẫn chạy). Fix theo pattern Company
> run-survival: thêm `packages/desktop/src/renderer/pages/browser/agentChatStore.ts` (singleton ngoài React, subscribe
> `onAgentEvent` always-on, mirror transcript vào `sessionStorage`), `packages/desktop/src/renderer/pages/browser/useAgentChat.ts` thành binding
> `useSyncExternalStore` (API public giữ nguyên). Test `tests/unit/browser/agentChatStore.dom.test.ts`
> (4) — tổng `tests/unit/browser/` 136/136. Module browser tsc sạch.

> **Cập nhật 2026-06-01 (Đợt 12 — IDE: Understand-Anything + Agent code thật + fix cây/wiki):** sửa 4 lỗi
> người dùng báo. **Gốc (cây trống + wiki chết):** 6 bridge IDE gom CHUNG 1 try/catch ở
> `process/bridge/index.ts` → một bridge ném lúc đăng ký làm `registerIdeFileBridge` (sau) bị skip →
> `ide.list-dir` không có provider → cây rỗng (scan-repo đứng đầu nên header vẫn báo số tệp). Đã TÁCH mỗi
> register* ra try/catch riêng (helper `register(label, fn)`). **Understand-Anything (Lum1104, MIT):** thêm
> mode **Understand** thay Map cũ — `packages/desktop/src/renderer/pages/studio/ide/components/UnderstandPanel.tsx` + `KnowledgeGraphView.tsx` (React Flow
> theo layer-columns) + `packages/desktop/src/renderer/pages/studio/ide/useUnderstand.ts`; backend `packages/desktop/src/process/ide/knowledgeGraphBuilder.ts` (structural pass
> regex symbols + heuristic layer, semantic pass LLM batched → summary/tags/tours) + `packages/desktop/src/process/ide/knowledgeGraphBridge.ts`
> (kênh `ide.kg-build/-get/-event`, persist `userData/ide-knowledge/<hash>.json`). **Agent code thật:** thêm
> mode **Agent** — `packages/desktop/src/renderer/pages/browser/components/AgentChatPanel.tsx` + `useCodeAgent.ts`; backend `codeAgentRunner.ts` (ReAct:
> read/list/**search_code**/**edit_file** + **web_search ẩn**, toggle "Allow edits") + `codeAgentBridge.ts`
> (kênh `ide.agent-run/-cancel/-event`). Activity bar IDE giờ **Files/Understand/Agent/Ask/Wiki** (bỏ Map).
> Sửa Arco Tree (`toTreeNodes` thư mục `children:[]`). XOÁ bản wiki trùng `wikiBuilder.ts`/`wikiBridge.ts`
> (canonical là `ideWikiBridge`+`wikiPlanner`). i18n `ide.understand.*`/`ide.agent.\*`/`ide.mode.{understand,agent}`(9 locale). Test`tests/unit/ide/` 64/64 (codeAgentRunner 9, knowledgeGraphBuilder 12, useUnderstand.dom,
> AgentChatPanel.dom, …). tsc sạch toàn dự án.

> **Cập nhật 2026-06-01 (Studio — Tạo tệp có agent tạo nội dung):** luồng "Tạo tệp" ở Studio dashboard
> nâng từ tạo-file-rỗng thành modal 2 chế độ `packages/desktop/src/renderer/pages/studio/components/CreateFileModal.tsx` + `packages/desktop/src/renderer/pages/studio/hooks/useFileCreator.ts`:
> **Empty** (như cũ) và **Generate (AI)** — nhập mô tả + đính kèm file tham chiếu (tùy ý), agent đọc
> reference theo loại rồi gọi `studio.chat` sinh nội dung và ghi đúng dạng theo loại file đích
> (`.docx`/`.xlsx`/text). i18n `studio.create.*` (+16 key, 9 locale). Test
> `tests/unit/studio/CreateFileModal.dom.test.tsx` (3) — xem mục "Create file" trong Section 23/Studio.

> **Cập nhật 2026-06-01 (Đợt 11 — CLI agent cho tác vụ AI nền):** trước đây mọi surface AI chạy
> nền (Browser web-agent, Studio chat, IDE explain/wiki, Make Video, Testing scenario/app-detect)
> đều gọi cứng provider OpenAI (`POST {base_url}/chat/completions` + `Authorization: Bearer`), nên
> KHÔNG dùng được endpoint định dạng Anthropic và KHÔNG tận dụng được CLI agent (gói OAuth/subscription).
> Module mới `process/services/agentChat/` sửa gốc: `packages/desktop/src/process/services/agentChat/cliModelId.ts` (mã hoá `cli:<agentId>`),
> `packages/desktop/src/process/services/agentChat/cliAgentDriver.ts` (driver thuần, DI: tạo conversation → gửi prompt → chờ turn → đọc đáp án → cleanup),
> `packages/desktop/src/process/services/agentChat/mainBackendWs.ts` (WS riêng cho **Main process** vì `httpBridge.ensureWs` no-op khi thiếu `window`;
> có fallback poll REST `GET /api/conversations/{id}/messages`), `packages/desktop/src/process/services/agentChat/cliAgentChat.ts` (`withCliAgent(inner)`
> wrap drop-in cho `AgentChat`), `index.ts` (`runAgentChatMessages` cho các bridge flat `(model,messages)`).
> Wiring: `browserBridge` (web-agent), `studioChatBridge`, `ide/ideProvider`, `makevideo/makeVideoBridge`,
> `testing/scenarioGenerator` + `appDetector`. Model id thường → đường provider cũ (không đổi hành vi).
> UI: `AgentModePicker` (Browser) thêm nhóm "CLI Agents" (value `cli:<id>`) + i18n `browser.agent.cliGroup`/
> `providerGroup`/`cliSuffix` (9 locale). Test `tests/unit/agentChat/cliAgentDriver.test.ts` 11/11.
> Monitor `analyzerAgent` GIỮ NGUYÊN (tự chọn model nền, không có picker người dùng).

> **Cập nhật 2026-05-31 (Đợt 5 — Company chat):** thêm chat sếp↔nhân viên THẬT chạy in-process —
> `packages/desktop/src/process/company/companyConversation.ts` (engine delegate + cổng phê duyệt + bảng trạng thái, lease 'agent')
>
> - `packages/desktop/src/process/company/companyChat.ts` (gọi model người dùng); `companyBridge` +4 kênh `company.run-conversation`/
>   `resolve-permission`/`cancel-conversation` + emitter `conversation-event`. Renderer:
>   `packages/desktop/src/renderer/pages/company/useCompanyConversation.ts` + `pages/company/manager/` (ManagerPopup/StatusBoard/ConversationTranscript/
>   PermissionPanel), nút "Manager" trên CompanyPage. i18n `company.conversation.*` (9 locale). Test:
>   `tests/unit/company/` 69/69 (companyConversation 8 + ManagerPopup.dom 6 mới).

> **Cập nhật 2026-05-31 (Đợt 8 — IDE hợp nhất + Wiki kiểu DeepWiki):** gộp 2 surface Studio rời rạc
> (`StudioIde` = cây file + editor; `RepoIntelView` = đồ thị import + hỏi đáp) thành MỘT workspace
> `packages/desktop/src/renderer/pages/studio/ide/IdeWorkspace.tsx` với activity-bar 4 chế độ: **Files** (cây file `fs.getFilesByDir` +
> `UniversalEditor`, editor giữ mounted để AI edit chạy nền), **Map** (đồ thị phụ thuộc `RepoGraphView`),
> **Ask** (`ExplainPanel`, grounding theo node chọn), **Wiki** (MỚI). State chung ở `packages/desktop/src/renderer/pages/studio/ide/useIdeWorkspace.ts`
> (một folder nuôi cả 4 tab); xoá `components/StudioIde.tsx`, `ide/RepoIntelView.tsx`, `ide/useRepoIntel.ts`.
> **Wiki (DeepWiki-style)**: backend `packages/desktop/src/process/ide/ideWikiBridge.ts` (kênh `ide.wiki-plan` quét repo + chọn
> key files + dựng digest + outline; `ide.wiki-section` viết từng mục Markdown qua provider), planner PURE
> `packages/desktop/src/process/ide/wikiPlanner.ts` (`selectKeyFiles` ưu tiên doc→manifest→entry→hub; `planWikiSections` suy
> outline từ repo: overview/architecture/modules + dataModel/api có điều kiện + buildRun), helper chung
> `packages/desktop/src/process/ide/ideProvider.ts` (gộp resolve provider + chat từ `ideExplainBridge`). Renderer: `packages/desktop/src/renderer/pages/studio/ide/useRepoWiki.ts`
> (plan → viết tuần tự từng mục, retry mỗi mục), `packages/desktop/src/renderer/pages/studio/ide/components/WikiPanel.tsx` (nav mục + Markdown stream +
> Mermaid + evidence). i18n `ide.workspace.*`/`ide.mode.*`/`ide.map.*`/`ide.wiki.*` (9 locale). Test
> `tests/unit/ide/`: +`tests/unit/ide/wikiPlanner.test.ts` (10) +`tests/unit/ide/WikiPanel.dom.test.tsx` (6) → tổng 32 pass. tsc sạch.

> **Cập nhật 2026-05-31 (Đợt 7 — Omni: Automation + IDE + Make Video trong Studio):** 3 sub-app mới
> trong Studio, tất cả qua API cloud (model người dùng), web-native, dùng React Flow `@xyflow/react@12`
> thay vì tự build. Backend in-process (mirror studioChatBridge/managerStore): `process/automation/`
> (workflow engine n8n-style, agent chỉ là 1 node, RunEvent stream), `process/ide/` (repoGraph PURE +
> ideBridge scan + ideExplainBridge), `process/makevideo/` (script LLM + image gen qua imageGenCore).
> Đăng ký ở `initAllBridges()`. Renderer: `studio/automation/`, `studio/ide/`, `studio/makevideo/`
> (mỗi feature 1 sub-view; React Flow cho workflow canvas + repo dependency graph). i18n +3 module
> `automation`/`ide`/`makeVideo` (9 locale) + 3 key `studio.*`. Fix kèm: xoá block trùng trong
> `packages/desktop/src/renderer/pages/editor/adapters/collabClient.ts` (vite esbuild 6 lỗi). Test 76/76 pass, tsc sạch toàn dự án.

> **Cập nhật 2026-05-31 (Đợt 6 — Company pipeline LÀM VIỆC THẬT, spec `agent-company-pipeline`):**
> thêm `renderer/pages/company/pipeline/` (10 file) — engine ĐỆ QUY điều khiển bởi soul/rule: `roleRunner`
> (runRole đệ quy A→B→C/D, guard depth+cycle), `delegationPlanner` (model quyết delegate/execute/approval/
> test, chỉ giao con trực tiếp), `roleExecutor` (THỰC THI THẬT: conversation.sendMessage + chờ turn.completed
> trong workspace thật), `soulComposer` (dựng soul/workflow lúc chạy — không persist), `approvalGate`/`testGate`
> (duyệt + vòng test qua testingClient), `pipelineStore`/`companyPipeline`/`pipelineChat`/`pipelineTypes`.
> Hook `useCompanyPipeline`; Manager popup thêm `packages/desktop/src/renderer/pages/company/manager/RoleTreeBoard.tsx` + `packages/desktop/src/renderer/pages/company/manager/ArtifactList.tsx` + switch chế độ
> Pipeline(thật)/Conversation(diễn). i18n `company.pipeline.*` (9 locale). Orchestrator nằm RENDERER (tái dùng
> conversation API, không sửa aioncore). Test `tests/unit/company/` 101/101.

> **Cập nhật 2026-05-31 (Đợt 6 — "Super" fix 3 lỗi):** Toggle Super (`packages/desktop/src/renderer/pages/conversation/components/ConversationSurfaces.tsx`) giờ
> đọc trạng thái THẬT từ `session_mcp_servers` (`packages/desktop/src/renderer/pages/conversation/hooks/useSuperMode.ts`), không chỉ localStorage; bật Super
> KHÔNG còn tự mở composer "Khung song song"; nút Watch mở popup live-browser trong chat
> (`packages/desktop/src/renderer/pages/conversation/components/superWatch/LiveBrowserWatch.tsx` + `packages/desktop/src/renderer/pages/conversation/hooks/useLiveBrowserTabs.ts`) kiểu agent ChatGPT. `packages/desktop/src/process/resources/builtinMcp/browserControlServer.ts` thêm
> tool `browser_list_tabs` + hướng dẫn mở nhiều tab (thay vì spawn sub-agent). i18n `workspace.watch*`
> (9 locale). Test `tests/unit/workspace/ConversationSurfaces.dom.test.tsx` (3). Xem mục "Super" cuối Section 29.

> **Cập nhật 2026-05-31 (FIX — Company run sống sót khi đổi tab / refresh):** Manager popup trước đây
> giữ trạng thái run TRONG component → đổi tab (unmount `CompanyPage`) hoặc refresh là mất run. Đã chuyển
> sang **session module-level** keyed theo companyId, sống ngoài React: `packages/desktop/src/renderer/pages/company/useCompanyPipeline.ts` (Pipeline,
> renderer-driven) không còn `stop()` lúc unmount, attach/subscribe lại khi remount, mirror snapshot vào
> `sessionStorage` (reload → khôi phục transcript/board; run đang chạy hạ thành `stopped` vì vòng lặp renderer
> không resume sau hard reload); `packages/desktop/src/renderer/pages/company/useCompanyConversation.ts` (Conversation, Main-driven) dùng MỘT subscription
> always-on tới event stream + session persist → engine Main vẫn chạy, UI tái gắn sau đổi tab/refresh.
> `pipelineStore.createPipelineStore(initial?)` nhận snapshot seed. Test `tests/unit/company/runSurvival.dom.test.tsx`
> (3); tổng `tests/unit/company/` **108/108**.

---

## Mục lục

1. [Tổng quan dự án](#1-tổng-quan-dự-án)
2. [Tech Stack](#2-tech-stack)
3. [Cấu trúc Monorepo](#3-cấu-trúc-monorepo)
4. [Kiến trúc hệ thống](#4-kiến-trúc-hệ-thống)
5. [Package: desktop](#5-package-desktop)
   - 5.1 [Main Process (process/)](#51-main-process-process)
   - 5.2 [Renderer Process (renderer/)](#52-renderer-process-renderer)
   - 5.3 [Preload / IPC Bridge](#53-preload--ipc-bridge)
   - 5.4 [Common (shared)](#54-common-shared)
6. [Package: web-host](#6-package-web-host)
7. [Package: web-cli](#7-package-web-cli)
8. [Package: shared-scripts](#8-package-shared-scripts)
9. [Backend: aioncore (Rust)](#9-backend-aioncore-rust)
10. [Database Schema](#10-database-schema)
11. [API Surface (HTTP + WebSocket)](#11-api-surface-http--websocket)
12. [Renderer: Pages & Routing](#12-renderer-pages--routing)
13. [Renderer: Components](#13-renderer-components)
14. [Renderer: Hooks](#14-renderer-hooks)
15. [Renderer: Services & Utils](#15-renderer-services--utils)
16. [i18n (Đa ngôn ngữ)](#16-i18n-đa-ngôn-ngữ)
17. [Theming & CSS](#17-theming--css)
18. [Agent & Multi-Agent System](#18-agent--multi-agent-system)
19. [Team Mode](#19-team-mode)
20. [MCP (Model Context Protocol)](#20-mcp-model-context-protocol)
21. [Remote Access & Channels](#21-remote-access--channels)
22. [Scheduled Tasks (Cron)](#22-scheduled-tasks-cron)
23. [Preview Panel](#23-preview-panel)
24. [Desktop Pet](#24-desktop-pet)
25. [Quy ước Code](#25-quy-ước-code)
26. [Workflow Phát triển](#26-workflow-phát-triển)
27. [Testing](#27-testing)
28. [Build & Distribution](#28-build--distribution)
29. [Spec đang mở: Tomni Agentic Enhancements](#29-spec-đang-mở-omniagent-enhancements)
30. [Spec đang mở: Personal Manager](#30-spec-đang-mở-personal-manager)

---

## 1. Tổng quan dự án

**AionUi** là ứng dụng desktop mã nguồn mở (Apache-2.0), cross-platform (macOS / Windows / Linux),
đóng vai trò nền tảng "Cowork" — nơi các AI agent làm việc cùng người dùng trực tiếp trên máy tính.

### Điểm cốt lõi

Tính theo CODE thực tế, app có **2 nhóm chức năng lớn**: (A) bộ chức năng "lõi" AionUi và
(B) bộ chức năng Tomni Agentic/Studio/Manager mở rộng (mỗi cái có route + bridge + i18n module riêng,
xác minh qua `packages/desktop/src/renderer/components/layout/Router.tsx`, `process/bridge/index.ts`, `packages/desktop/src/common/config/i18n-config.json`).

#### A. Chức năng lõi

| Tính năng            | Mô tả                                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| **Built-in Agent**   | Engine tác nhân tích hợp sẵn, cài là chạy, không cần cài thêm CLI                                                                     |
| **Multi-Agent**      | Tự phát hiện Claude Code, Codex, Gemini CLI, Qwen Code, Goose, OpenClaw...                                                            |
| **Team Mode**        | Leader agent chia việc cho Teammate agents chạy song song                                                                             |
| **Assistants**       | Trợ lý chuyên biệt (PPT, Word, Excel, Academic Paper, Financial Model, UI/UX, Story Roleplay...) — quản lý qua `/settings/assistants` |
| **Preview Panel**    | Xem trực tiếp PDF, Word, Excel, PPT, code, Markdown, ảnh, HTML, Diff                                                                  |
| **Remote Access**    | WebUI (browser), Telegram, Lark, DingTalk, WeChat, WeCom                                                                              |
| **Cron Tasks**       | Lập lịch tác vụ 24/7 không cần giám sát                                                                                               |
| **30+ AI Platforms** | Gemini, Claude, OpenAI, DeepSeek, Ollama, AWS Bedrock, NewAPI...                                                                      |
| **Local Storage**    | Toàn bộ dữ liệu lưu SQLite cục bộ, không upload lên server                                                                            |
| **Desktop Pet**      | Nhân vật ảo tương tác với trạng thái AI                                                                                               |

#### B. Chức năng Tomni Agentic / Studio / Manager (mở rộng)

| Tính năng               | Route / vị trí              | Mô tả (xác minh qua code)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Resource Dashboard**  | `/settings/resource`        | ResourceCoordinator — cấp/queue lease cho tác vụ nặng, 3 mức cân bằng (desktop-only)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Agent Company**       | `/settings/company`         | Mô hình công ty tác nhân: sinh sơ đồ vai trò, gán CLI/Assistant, chat sếp↔nhân viên, pipeline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Embedded Browser**    | `/settings/browser`         | Trình duyệt nhúng (WebContentsView) + web-agent ReAct (navigate/click/type/screenshot)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Studio**              | `/studio`                   | File hub kiểu WPS → Universal Editor; sub-app: Make Video, Automation, Repo IDE                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Universal Editor**    | (nhúng trong Studio)        | 8 adapter: text-code (Monaco), docx, spreadsheet, slide, pdf, image, media, binary-inspect — docx/xlsx/pptx/**pdf** mặc định mở ONLYOFFICE (WYSIWYG), tự fallback editor nhẹ khi Office lỗi                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Multi-platform Test** | `/settings/testing`         | Sinh kịch bản → chạy test (web chạy thật; Android/Windows "unavailable"); script + computer-use                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Bug Monitor**         | `/settings/monitor`         | Thu lỗi → phân tích → đề xuất bản vá → cổng duyệt → rollback (vòng khép kín)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Personal Manager**    | `/manager`                  | Tasks / Note / Schedule + AI (parse, optimize, nhắc lịch, weather/travel/web search)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **News Aggregator**     | `/settings/realtime`        | "Thời gian thực" — 2 view **News / Chứng khoán**. News: RSS/Atom + realtime social (Bluesky Jetstream WS, `packages/desktop/src/process/news/realtimeConnector.ts` — **opt-in** qua nút Live, watchdog + reconnect jitter + gating theo setting); trang tech **Top 10 GitHub** (`packages/desktop/src/process/news/githubTrending.ts`); dịch không-LLM (`packages/desktop/src/process/news/newsTranslator.ts`, MyMemory, budget ký tự/ngày); fetch feed chỉ http(s). Chứng khoán: `packages/desktop/src/process/news/marketFetcher.ts` — **Yahoo v8** (daily-change chuẩn vs prev close) + fallback Stooq + crypto CoinGecko, keyless → `packages/desktop/src/renderer/pages/news/components/MarketView.tsx` với **watchlist tùy chỉnh** (thêm/xóa mã Yahoo: `AAPL`/`^GSPC`/`BTC-USD`, lưu `settings.marketSymbols`). UI thuần Arco (Radio.Group/Button/Input). |
| **Automation**          | Studio › Automation         | Workflow n8n-style: trigger/HTTP/AI/transform + app (Make Video→mp4, Editor) + cloud (S3/WebDAV) + Email/Facebook/TikTok + Agent Company (create/goal/tasks)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Repo Intelligence**   | Studio › IDE                | Quét repo → dependency graph + giải thích codebase (provider-backed)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Make Video**          | Studio › Make Video         | Sinh kịch bản LLM + render ảnh từng cảnh (cloud, provider người dùng)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Tool Selector**       | (Agent-plane MCP)           | Tự chọn skill/tool 2 tầng (keyword → semantic) trước khi nạp                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Workspace frames**    | (nhúng trong chat, "Super") | Nhiều sub-agent chạy song song trên các surface live (browser/editor)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Terminal manager**    | `/settings/terminal`        | Quản lý terminal: tạo/tương tác shell thật, đếm shell toàn máy (read-only), lập lịch chạy script (croner)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Thông tin dự án

- **Repo:** `c:\NDT\PJ\AionUi`
- **Version:** 2.1.7
- **Node.js:** ≥ 22, < 25
- **Package manager:** Bun
- **aioncore version:** v0.1.16 (Rust backend binary)

---

## 2. Tech Stack

| Layer                 | Công nghệ                                        |
| --------------------- | ------------------------------------------------ |
| Desktop shell         | Electron 37                                      |
| UI framework          | React 19 + TypeScript 5.8                        |
| Bundler               | electron-vite 5 (Vite 6 bên trong)               |
| CSS                   | UnoCSS (utility-first) + CSS Modules             |
| UI component lib      | @arco-design/web-react 2.66                      |
| Icon lib              | @icon-park/react 1.4                             |
| State / data fetching | SWR 2                                            |
| Routing               | react-router-dom 7 (HashRouter)                  |
| i18n                  | i18next 23 + react-i18next 14                    |
| Database              | better-sqlite3 12 (SQLite, main process)         |
| Backend runtime       | aioncore (Rust binary, bundled)                  |
| HTTP client           | fetch API (custom httpBridge wrapper)            |
| WebSocket             | Native WebSocket (singleton, auto-reconnect)     |
| Markdown              | react-markdown 10 + remark-gfm + rehype-katex    |
| Code editor           | @monaco-editor/react + @uiw/react-codemirror     |
| Node graph / flow     | @xyflow/react 12 (Automation canvas + IDE graph) |
| Linter                | oxlint 1.56                                      |
| Formatter             | oxfmt 0.41                                       |
| Test framework        | Vitest 4 + @testing-library/react                |
| E2E tests             | Playwright 1.58                                  |
| Error tracking        | @sentry/electron 7                               |
| Auto-update           | electron-updater 6                               |

---

## 3. Cấu trúc Monorepo

```
AionUi/                          ← workspace root
├── packages/
│   ├── desktop/                 ← Electron app (main package)
│   ├── web-host/                ← Library: khởi động backend + static server
│   ├── web-cli/                 ← CLI binary: chạy WebUI không cần Electron
│   ├── music-core/              ← Headless music engine (renderer-safe, no Node API)
│   └── shared-scripts/          ← Build scripts dùng chung
├── tests/
│   ├── e2e/                     ← Playwright end-to-end tests
│   ├── integration/             ← Integration tests
│   ├── unit/                    ← Unit tests
│   └── fixtures/
├── docs/                        ← Tài liệu (guides, contributing, prds, specs)
├── scripts/                     ← Build & tooling scripts
├── resources/                   ← Icons, images, installer scripts
├── public/                      ← Vite public assets (PWA manifest, sw.js)
├── mobile/                      ← React Native mobile app (Expo)
├── examples/                    ← Extension examples
├── patches/                     ← bun patch-package patches
├── package.json                 ← Workspace root (Bun workspaces)
├── tsconfig.json                ← Shared TypeScript config
├── vitest.config.ts             ← Shared test config
├── uno.config.ts                ← UnoCSS config + semantic color tokens
├── playwright.config.ts         ← E2E test config
├── justfile                     ← `just push` workflow
└── AGENTS.md                    ← Quy tắc cho AI agents (đọc bắt buộc)
```

### Workspace packages

| Package                   | Tên npm                  | Mô tả                                         |
| ------------------------- | ------------------------ | --------------------------------------------- |
| `packages/desktop`        | (private)                | Electron desktop app — toàn bộ UI và logic    |
| `packages/web-host`       | `@aionui/web-host`       | Khởi động aioncore + static HTTP server       |
| `packages/web-cli`        | `@aionui/web-cli`        | CLI `aionui-web` — chạy WebUI standalone      |
| `packages/music-core`     | `@aionui/music-core`     | Headless music engine (UI + agent dùng chung) |
| `packages/shared-scripts` | `@aionui/shared-scripts` | Script chuẩn bị aioncore binary               |

---

## 4. Kiến trúc hệ thống

### Sơ đồ tổng thể

```
┌─────────────────────────────────────────────────────────────┐
│                    Electron App                              │
│                                                             │
│  ┌──────────────┐   contextBridge   ┌──────────────────┐   │
│  │ Main Process │ ◄────────────────► │ Renderer Process │   │
│  │ (Node.js)    │   IPC (Electron)   │ (React + DOM)    │   │
│  │              │                   │                  │   │
│  │ - Window mgmt│                   │ - UI components  │   │
│  │ - Tray       │                   │ - Pages/Routes   │   │
│  │ - Auto-update│                   │ - Hooks/Context  │   │
│  │ - Deep links │                   │                  │   │
│  └──────┬───────┘                   └────────┬─────────┘   │
│         │                                    │             │
│         │ HTTP REST + WebSocket              │             │
│         └──────────────┬─────────────────────┘             │
│                        │                                   │
│              ┌─────────▼──────────┐                        │
│              │  aioncore (Rust)   │                        │
│              │  Port: dynamic     │                        │
│              │                   │                        │
│              │ - Conversations    │                        │
│              │ - Agents (ACP)     │                        │
│              │ - MCP servers      │                        │
│              │ - File system      │                        │
│              │ - Skills           │                        │
│              │ - Providers/Models │                        │
│              │ - Cron jobs        │                        │
│              │ - Teams            │                        │
│              │ - WebUI server     │                        │
│              │ - Channels (TG...) │                        │
│              └────────────────────┘                        │
└─────────────────────────────────────────────────────────────┘
```

### Nguyên tắc quan trọng nhất

> **Main Process KHÔNG chứa business logic.** Toàn bộ logic AI, conversation, file system,
> MCP, cron... đều nằm trong **aioncore** (Rust binary). Main process chỉ:
>
> - Quản lý cửa sổ Electron
> - Khởi động aioncore
> - Xử lý IPC cho các tính năng Electron-native (dialog, tray, auto-update, deep links)

### Hai loại giao tiếp

| Loại                   | Dùng khi                  | Ví dụ                                       |
| ---------------------- | ------------------------- | ------------------------------------------- |
| **IPC (Electron)**     | Tính năng Electron-native | Mở dialog, zoom, restart app, auto-update   |
| **HTTP/WS → aioncore** | Mọi business logic        | Conversations, agents, MCP, files, settings |

---

## 5. Package: desktop

Entry point: `packages/desktop/src/`

```
packages/desktop/src/
├── index.ts          ← Main process entry (khởi động Electron + aioncore)
├── sentry.ts         ← Sentry error tracking init
├── types.d.ts        ← Ambient type declarations
├── process/          ← Main process code (Node.js only, NO DOM)
├── renderer/         ← Renderer process code (React, NO Node.js)
├── preload/          ← IPC bridge (contextBridge)
└── common/           ← Shared code (cả main lẫn renderer dùng)
```

### 5.1 Main Process (`process/`)

```
process/
├── index.ts                    ← Entry: initStorage + initBridge
├── bridge/                     ← IPC handlers (Electron-native + Tomni Agentic registration)
│   ├── index.ts                ← initAllBridges(): đăng ký TẤT CẢ bridges (Electron-native + Tomni Agentic)
│   ├── applicationBridge.ts    ← App restart, devtools, zoom, CDP, GPU; getApplicationMainWindow()
│   ├── applicationBridgeCore.ts← Core handlers tách khỏi applicationBridge
│   ├── dialogBridge.ts         ← Native file picker dialog
│   ├── windowControlsBridge.ts ← Min/max/close window
│   ├── updateBridge.ts         ← Manual update check/download
│   ├── systemSettingsBridge.ts ← Start on boot, system info paths
│   ├── notificationBridge.ts   ← Desktop notifications
│   ├── webuiBridge.ts          ← WebUI port/config
│   ├── defaultBrowser.ts       ← Đăng ký AionUi làm trình duyệt mặc định (Windows)
│   └── feedbackBridge.ts       ← Log collection, screenshot
├── services/
│   ├── database/               ← SQLite schema, migrations, repositories
│   │   ├── schema.ts           ← Tạo tables + indexes; CURRENT_DB_VERSION = 26
│   │   ├── migrations.ts       ← Migration steps (version 1→26)
│   │   ├── runLegacyDatabaseMigrations.ts ← Chạy migration cũ khi version thấp
│   │   └── drivers/            ← ISqliteDriver interface + implementations
│   ├── i18n/                   ← i18n cho main process
│   ├── autoUpdaterService.ts   ← electron-updater wrapper
│   └── autoUpdateDiagnostics.ts
├── backend/
│   ├── index.ts                ← BackendManager: khởi động aioncore
│   └── binaryResolver.ts       ← Tìm aioncore binary (bundled hoặc PATH)
├── startup/
│   ├── backendStartup.ts       ← startBackendOrExit() helper
│   ├── backendStartupFailure.ts← Xử lý lỗi khởi động
│   ├── backendInstallDiagnostics.ts
│   └── quitCleanup.ts          ← Dọn dẹp khi thoát app
├── pet/                        ← Desktop Pet system
│   ├── petManager.ts           ← Quản lý cửa sổ pet
│   ├── petStateMachine.ts      ← State machine: idle/active/thinking...
│   ├── petEventBridge.ts       ← IPC bridge cho pet
│   ├── petIdleTicker.ts        ← Tick idle timer
│   ├── petConfirmManager.ts    ← Tool confirmation qua pet bubble
│   └── petTypes.ts
│
│   ── Tomni Agentic modules (Main-process, KHÔNG đụng aioncore Rust) ──
├── resource/                   ← Yêu cầu 5: ResourceCoordinator (lease cho tác vụ nặng)
│   ├── resourceCoordinator.ts  ← Coordinator chính: cấp/queue lease theo TaskKind
│   ├── resourceBridge.ts       ← Kênh resource.* + emitter cho Resource Dashboard
│   ├── systemProbe.ts          ← Đọc RAM/CPU/GPU/disk lúc khởi động (DI cho test)
│   ├── gpuProbe.ts             ← Detect GPU rời qua Electron app.getGPUInfo (không thêm dep)
│   ├── balanceAdvisor.ts       ← Gợi ý cân bằng (3 bậc)
│   ├── balancePolicy.ts        ← Chính sách 3 mức (Tiết kiệm/Cân bằng/Hiệu năng) + suggestPreset
│   ├── resourceState.ts        ← State machine của coordinator
│   └── leaseTypes.ts           ← TaskKind + lease types
├── browser/                    ← Yêu cầu 1: Embedded browser + web agent
│   ├── browserViewManager.ts   ← Quản lý WebContentsView tabs (setZoom, setBounds...)
│   ├── webAgentRunner.ts       ← Vòng lặp ReAct (navigate/click/type/screenshot/finish...)
│   ├── providerChat.ts         ← Gọi LLM /chat/completions (provider người dùng chọn)
│   ├── browserMemory.ts        ← Persona + ghi chú theo site (browser-agent-memory.json)
│   ├── pagePerception.ts       ← Trích xuất nội dung/cấu trúc trang
│   ├── humanLikeInput.ts       ← Mô phỏng input giống người
│   ├── mediaPipeline.ts        ← Orchestration video/audio (transcript...)
│   ├── research/               ← Lớp nghiên cứu: readability.ts (trích nội dung chính),
│   │                             summarizer.ts (map-reduce, bỏ trần 4000 ký tự),
│   │                             deepResearch.ts (plan→search song song→read→synthesize có citation)
│   ├── browserBridge.ts        ← Kênh browser.* (UI plane + Agent plane chung 1 bridge)
│   ├── browserControlMcpHost.ts← Host Browser-Control MCP in-process (127.0.0.1/sse)
│   ├── browserControlWiring.ts ← Build deps cho Browser-Control MCP + start host
│   └── registerBrowserControlMcp.ts ← Đăng ký Browser-Control MCP vào catalog (sse)
├── studio/                     ← Yêu cầu 2a: Studio doc-assistant + Office read/write
│   ├── studioChatBridge.ts     ← Kênh studio.chat (provider-backed completion)
│   ├── studioFsBridge.ts       ← Ghi/đọc file binary an toàn (raw bytes, ví dụ .docx)
│   ├── studioDocxBridge.ts     ← Đọc/ghi .docx theo path (Node mammoth/docx)
│   ├── studioOfficeBridge.ts   ← Đọc/ghi .xlsx (CSV)/.pptx (text) theo path
│   ├── onlyOfficeBridge.ts     ← Kênh studio.office-edit-*/ensure-server (ONLYOFFICE on-demand)
│   ├── onlyOfficeServer.ts     ← Local HTTP host phục vụ file cho Document Server
│   └── documentServerManager.ts ← ensureDocumentServer: dùng URL cấu hình hoặc tự start Docker DS
├── conversion/                 ← Chuyển đổi tài liệu (PDF↔Word...)
│   ├── conversionService.ts    ← Điều phối convert
│   ├── conversionTypes.ts
│   ├── pdfToWord.ts / pdfScanToWord.ts / wordToPdf.ts
├── toolselect/                 ← Yêu cầu 7: Tác nhân tự chọn skill/tool
│   ├── toolSelector.ts         ← Vòng chọn–thử–chọn lại
│   ├── catalog.ts / catalogTypes.ts ← Catalog skill/tool + mô tả
│   ├── keywordFilter.ts        ← Bậc 1: lọc từ khóa
│   ├── semanticFilter.ts       ← Bậc 2: lọc ngữ nghĩa
│   └── selectionLog.ts         ← Log lựa chọn
├── company/                    ← Yêu cầu 3: Mô hình công ty tác nhân
│   ├── companyOrchestrator.ts  ← Điều phối roles
│   ├── companyGenerator.ts     ← Dựng sơ đồ vai trò từ mô tả (provider-backed)
│   ├── companyConfig.ts        ← Cấu hình công ty
│   ├── companyBridge.ts        ← Kênh company.* (gồm create-from-description/set-assignment/accept-drafts/update-structure/delete-company + run-conversation/resolve-permission/cancel + emitter conversation-event)
│   ├── companyConversation.ts  ← Engine hội thoại sếp↔nhân viên IN-PROCESS (delegate + cổng phê duyệt + board); lease 'agent'
│   ├── companyChat.ts          ← Gọi model người dùng (/chat/completions) cho engine hội thoại
│   ├── callTemplate.ts         ← Template gọi role
│   ├── contextLayering.ts      ← Phân tầng context
│   ├── memoryStore.ts          ← Lưu memory công ty
│   └── memoryCompactor.ts      ← Nén/tóm tắt memory
├── testing/                    ← Yêu cầu 2b: Kiểm thử đa nền tảng
│   ├── testOrchestrator.ts     ← Orchestrator singleton (UI plane + Agent plane chung)
│   ├── testingWiring.ts        ← getTestingServices(): build orchestrator dùng chung
│   ├── testingBridge.ts        ← Kênh testing.list-sessions/get-report/run (UI plane)
│   ├── testingMcpHost.ts       ← Host Testing MCP in-process trên 127.0.0.1/sse (Agent plane)
│   ├── registerTestingMcp.ts   ← Đăng ký Testing MCP vào catalog (sse, idempotent)
│   ├── scenarioGenerator.ts    ← Mô tả lời thường → AI sinh các bước test (provider-backed)
│   ├── appDetector.ts          ← Đọc source (README/package.json...) → AI đoán cách chạy app
│   ├── appLauncher.ts          ← Spawn app-under-test + chờ ready (url/port/log/delay)
│   ├── scriptDriver.ts         ← Script engine (goto/wait/assertText/click/type...)
│   ├── computerUseDriver.ts    ← Driver computer-use
│   ├── virtualDisplayManager.ts← Quản lý virtual display
│   ├── recorder.ts             ← Ghi ảnh/video phiên test
│   ├── reportBuilder.ts        ← Tạo report .md
│   ├── testingTypes.ts
│   └── platforms/              ← Platform targets (web chạy thật; Android/Windows "unavailable")
├── monitor/                    ← Yêu cầu 6: Bug monitor + auto-fix (vòng khép kín)
│   ├── bugMonitor.ts           ← Thu lỗi → phân tích → vá → cổng duyệt → nhớ
│   ├── monitorWiring.ts        ← getMonitorServices(): build services dùng chung
│   ├── monitorBridge.ts        ← Kênh monitor.* (list/report/approve/reject/rollback)
│   ├── sentryErrorSource.ts    ← Tap pub/sub từ sentry.ts beforeSend (không init Sentry lần 2)
│   ├── reportStore.ts          ← Lưu + dedup theo signature
│   ├── proposalStore.ts        ← Persist PatchProposal (recall known-fix)
│   ├── rootCauseAnalyzer.ts    ← Phân tích nguyên nhân
│   ├── codeContextProvider.ts  ← Đọc file trong stack (chỉ trong app root)
│   ├── analyzerAgent.ts        ← Provider-backed: trả JSON {rootCause,diff,risk}
│   ├── patchValidationSandbox.ts ← Sandbox cô lập áp diff + validate (lease patchBuild)
│   ├── patchSandbox.ts         ← Sandbox đầy đủ chạy Windows-test (chờ engine OS)
│   ├── patchGate.ts            ← Cổng duyệt (auto-apply chỉ low-risk)
│   ├── patchApplier.ts         ← Snapshot trước khi áp + restore (rollback)
│   ├── gitRunner.ts            ← GitRunner (execFile git, no shell) + PrOpener (gh CLI)
│   ├── releasePublisher.ts     ← Publish fix → nhánh fork + mở/đưa link PR (manual merge)
│   ├── monitorTypes.ts / monitorViewTypes.ts
├── editor/                     ← Editor-control plane cho Super (live editor frames)
│   ├── editorFrameStore.ts     ← Registry frame Main-process (version bump để renderer reload)
│   └── editorControlBridge.ts  ← Kênh editor.list-frames/close-frame (đăng ký ở initAllBridges)
├── workspace/                  ← Tính năng bổ sung: multi-sub-agent live frames
│   ├── workspaceOrchestrator.ts← Chạy N surface song song (lease 'agent' qua coordinator)
│   ├── browserSurfaceRunner.ts ← Mỗi surface 1 tab riêng (reuse webAgentRunner)
│   ├── editorAgentRunner.ts    ← Đọc file → model trả JSON write/finish → ghi /api/fs/write
│   ├── surfaceTypes.ts         ← SurfaceSpec/State/Event, ISurfaceRunner (import type 2 process)
│   └── workspaceBridge.ts      ← Kênh workspace.run/cancel + emitter workspace.event
├── cron/                       ← Scheduled Tasks Agent plane (Cron MCP wiring)
│   ├── cronMcpHost.ts          ← In-process SSE host (loopback) cho Cron MCP
│   ├── cronWiring.ts           ← Build deps từ cron.* bridge + start host
│   └── registerCronMcp.ts      ← Đăng ký/refresh Cron MCP trong catalog (sse, enabled:false)
├── manager/                    ← Personal Manager (Tasks/Note/Schedule; xem mục 30)
│   ├── managerTypes.ts         ← Task/CalendarEvent/Note types
│   ├── managerStore.ts         ← File JSON manager-data.json (atomic, recurring spawn)
│   ├── managerAi.ts            ← parseTasks/parseSchedule(Image)/optimize/research/summarize
│   ├── weatherProvider.ts      ← Open-Meteo (keyless, degrade) cho tối ưu lịch
│   ├── travelProvider.ts       ← Thời gian di chuyển 3 tầng: Google → OSRM → ước lượng (degrade)
│   ├── webSearch.ts            ← Keyless web search (Wikipedia + DuckDuckGo) cho Note Learn
│   ├── reminderScheduler.ts    ← Ticker 60s + catch-up nhắc quá hạn (showNotification)
│   ├── managerBridge.ts        ← Kênh manager.* (envelope ManagerResult luôn-resolve)
│   ├── managerWiring.ts        ← getManagerServices(): store + AI + scheduler dùng chung
│   └── registerManagerMcp.ts   ← Đăng ký Manager MCP (stdio) vào catalog
├── automation/                 ← Omni Automation (workflow engine kiểu n8n; agent chỉ là 1 node)
│   ├── automationTypes.ts      ← Workflow (linear pipeline) + WorkflowNode (13 kind) + Artifact + RunEvent
│   ├── automationStore.ts      ← File JSON automation-workflows.json (atomic, defensive)
│   ├── nodeExecutors.ts        ← http/ai/transform/delay/log/trigger + app/cloud/email/social + DI
│   ├── workflowEngine.ts       ← Chạy tuần tự, fail-fast, abort, stream RunEvent (deterministic)
│   ├── connectors/             ← Connector từng node (factory DI, test được, no network/fs thật)
│   │   ├── artifacts.ts        ← Helper + Artifact (truyền file/metadata giữa node), {{input}} subst
│   │   ├── appActions.ts       ← action.app.makeVideo (Make Video + render mp4) + action.app.editor
│   │   ├── cloudUpload.ts      ← action.cloud.upload — S3 (SigV4 tự ký) / WebDAV (Basic auth)
│   │   ├── emailSend.ts        ← action.email.send — SMTP qua nodemailer (đính kèm artifact)
│   │   ├── facebookPost.ts     ← action.social.facebook — Graph API v21.0 feed/photos/videos
│   │   ├── tiktokPost.ts       ← action.social.tiktok — Content Posting API direct post
│   │   ├── companyAction.ts    ← action.company — create/goal/tasks qua Agent Company (auto-approve)
│   │   └── videoRender.ts      ← Ghép ảnh cảnh → .mp4 bằng ffmpeg-static (concat demuxer)
│   ├── conditions.ts           ← Evaluator điều kiện (15 operator) cho control.if/switch/filter
│   ├── automationScheduler.ts  ← Cron runner (croner) cho trigger.schedule
│   ├── webhookServer.ts        ← Listener loopback cho trigger.webhook (POST → run)
│   ├── credentialStore.ts      ← Vault AES-256-GCM (token/secret mã hóa)
│   ├── credentialBridge.ts     ← Kênh automation.cred.* + resolveCredentialFields
│   ├── automationChatBridge.ts ← Kênh automation.chat — AI Workflow Designer (chiều 1)
│   ├── automationMcpServer.ts  ← MCP server aionui-automation 7 tool (chiều 2)
│   ├── automationMcpHost.ts    ← SSE host loopback cho MCP server
│   ├── automationMcpWiring.ts  ← Build deps MCP từ shared services
│   ├── registerAutomationMcp.ts← Đăng ký MCP vào catalog (sse, opt-in)
│   └── automationBridge.ts     ← Kênh automation.* CRUD + run/cancel + emitter + scheduler/webhook
├── ide/                        ← Omni IDE repo-intelligence (hiểu codebase, không clone VS Code)
│   ├── understandTypes.ts      ← Types CHUNG cho Understand-Anything (KnowledgeGraph/Node/Tour/symbol)
│   ├── repoGraph.ts            ← PURE buildGraphFromFiles (parse import/require) + collectRepoFiles (DI) + extractExternals (C4 Context)
│   ├── ideProvider.ts          ← Helper CHUNG: resolve provider + runIdeChat (/chat/completions)
│   ├── ideBridge.ts            ← Kênh ide.scan-repo (walk fs + build graph import nhẹ)
│   ├── ideFileBridge.ts        ← Kênh ide.list-dir/read-file/write-file (Node fs, mở folder bất kỳ)
│   ├── wikiPlanner.ts          ← PURE selectKeyFiles + planWikiSections (chọn file + suy outline wiki)
│   ├── ideWikiBridge.ts        ← Kênh ide.wiki-plan (quét+digest+outline) + ide.wiki-section (viết Markdown)
│   ├── repoWatcher.ts          ← PURE/DI realtime watcher (fs.watch recursive + debounce) cho Live mode
│   ├── fallbackSummaryLocale.ts← Template fallback summary localized 9 locale (gen theo ngôn ngữ hệ thống)
│   ├── knowledgeGraphBuilder.ts← Understand-Anything: structural (regex+polyglot symbols+layer) + fingerprint + fallback summary (localized) + incremental reuse + LLM semantic (theo language)
│   └── knowledgeGraphBridge.ts ← Kênh ide.kg-build/-get + watch-start/-stop + diff + context + emitter ide.kg-event/-changed (load previous → incremental, persist per-repo, snapshot history 5 bản)
│   ├── graphSnapshot.ts        ← PURE diff 2 KG snapshot (added/removed/changed nodes+edges, commitHash)
│   ├── contextBuilder.ts       ← Lõi "agent hiểu code": lexical+graph ranker (DI) + expand + changed-boost + trim → ContextPack
│   ├── rulesLoader.ts          ← Đọc .aionrules/AGENTS.md/.cursorrules → rules array (DI fs)
│   ├── quickTestTracer.ts      ← CDP attach/detach, ghi trace (click/network/console/exception/navigate) khi user test; dùng quickTestBuffer + hasError()/recordedCount()
│   ├── quickTestBuffer.ts      ← PURE: rolling-buffer policy dùng chung web+native (pushBounded smart-eviction giữ error+interaction path khi log ồn, isErrorEvent/findFirstError)
│   ├── traceContextBuilder.ts  ← PURE: RuntimeTrace → ContextPack (map stack/network/selector → graph node)
│   ├── quickTestBridge.ts      ← Kênh ide.qt-start/-stop/-event (push-stream event significant qua onEvent, không polling)
│   └── quickTestBridgeHelpers.ts← loadGraph helper (tránh circular dep)
│   (Chat mode KHÔNG có bridge riêng — tái dùng hệ conversation/CLI-agent chính, xem renderer ide/IdeChatPanel)
├── makevideo/                  ← Omni Make Video (AI movie/anime, CLOUD-only qua provider người dùng)
│   ├── makeVideoTypes.ts       ← Scene/VideoProject/ScriptRequest + MakeVideoResult
│   ├── makeVideoStore.ts       ← File JSON make-video-projects.json (atomic, +updateScene)
│   └── makeVideoBridge.ts      ← makevideo.* CRUD + generate-script (LLM→parseScenes) + generate-image (imageGenCore)
│
├── resources/
│   └── builtinMcp/             ← Built-in MCP servers (in-process trừ manager là stdio)
│       ├── imageGenServer.ts   ← Image generation
│       ├── browserControlServer.ts ← Điều khiển browser
│       ├── companyServer.ts    ← Company tools
│       ├── resourceServer.ts   ← Resource tools
│       ├── testingServer.ts    ← Testing tools
│       ├── toolSelectorServer.ts ← Tool selector
│       ├── cronServer.ts       ← Cron tools (7 tools, Scheduled Tasks)
│       ├── managerServer.ts    ← Manager tools (stdio, Tasks/Note/Schedule)
│       └── constants.ts
├── feedback/
│   └── logs.ts                 ← Thu thập log files cho feedback
└── utils/
    ├── mainWindowLifecycle.ts  ← Tạo/quản lý main BrowserWindow
    ├── tray.ts                 ← System tray icon + menu
    ├── appMenu.ts              ← Native app menu (macOS menu bar)
    ├── deepLink.ts             ← aionui:// protocol + http/https (default-browser) handler
    ├── initBridge.ts           ← Khởi tạo tất cả IPC bridges
    ├── initStorage.ts          ← Khởi tạo SQLite database
    ├── windowBounds.ts         ← Lưu/khôi phục kích thước cửa sổ
    ├── zoom.ts                 ← Zoom factor management
    ├── gpuRecovery.ts          ← Auto-disable GPU sau crash
    ├── configureChromium.ts    ← Chromium flags (phải chạy đầu tiên)
    ├── configureConsoleLog.ts  ← Cấu hình console log
    ├── webuiConfig.ts          ← WebUI port/remote config
    ├── ensureAdminUser.ts      ← Tạo admin user lần đầu
    ├── migrateAssistants.ts    ← Migration assistants → backend
    ├── runBackendMigrations.ts ← Chạy DB migrations + đăng ký Testing/Browser-Control/Cron/Manager MCP
    ├── persistOnQuit.ts        ← Lưu state trước khi thoát
    ├── analyticsId.ts          ← Anonymous analytics ID
    ├── index.ts                ← Re-export utils
    └── resetPasswordCLI.ts     ← CLI reset password
```

> **Lưu ý wiring:** Các Tomni Agentic/Manager bridge KHÔNG nằm trong `process/bridge/`; chúng sống trong
> thư mục feature tương ứng và được đăng ký tập trung tại `initAllBridges()` (`process/bridge/index.ts`).
> Danh sách đầy đủ đăng ký ở đó: `resource`, `company`, `browser`, `editor-control`, `testing`,
> `monitor`, `studio.chat`, `studio.fs`, `studio.docx`, `studio.office`, `onlyOffice`, `workspace`,
> `manager`, `automation`, `ide.scan-repo`/`ide.explain`/`ide.wiki-plan`/`ide.wiki-section`/`ide.wiki-build`/`ide.wiki-load`/`ide.list-dir`/
> `ide.agent-*`/`ide.kg-*`, `makevideo`. Mỗi đăng ký bọc
> trong `try/catch` riêng để một bridge lỗi không chặn các bridge khác. Boot log dạng
> `[Bridge] <Tên> bridge registered.`. Các Agent-plane MCP (Testing/Browser-Control/Cron/Manager) được
> đăng ký vào MCP catalog ở `runBackendMigrations()` (sau khi backend sẵn sàng).

#### Luồng khởi động Main Process

```
index.ts
  1. import register-electron (platform services)
  2. import configureChromium (PHẢI đầu tiên — set app name + Chromium flags)
  3. app.whenReady()
  4. initStorage() → SQLite init + migrations
  5. initBridge() → đăng ký tất cả IPC handlers
  6. startBackend() → tìm aioncore binary → spawn process → chờ port
  7. createMainWindow() → BrowserWindow với preload
  8. loadURL(renderer) → React app khởi động
```

#### aioncore Binary Resolution

```
binaryResolver.ts tìm theo thứ tự:
  1. Bundled: {resourcesPath}/bundled-aioncore/{platform}-{arch}/aioncore[.exe]
  2. System PATH: `which aioncore` / `where aioncore`
  → Throw BackendBinaryResolveError nếu không tìm thấy
```

---

### 5.2 Renderer Process (`renderer/`)

```
renderer/
├── index.html          ← Vite HTML entry
├── main.tsx            ← React mount + providers + error screens
├── types.d.ts          ← Ambient declarations
├── pages/              ← Page-level modules (business code)
├── components/         ← Shared UI components
├── hooks/              ← Shared React hooks
├── services/           ← Client-side services (i18n, FileService, PWA...)
├── utils/              ← Utility functions
├── styles/             ← Global styles + themes
├── assets/             ← Static assets (logos, icons, themes)
└── pet/                ← Pet renderer HTML + scripts
```

#### Khởi động Renderer (`packages/desktop/src/renderer/main.tsx`)

```
main.tsx
  1. Init Sentry (electron renderer SDK nếu có electronAPI)
  2. Import runtimePatches (polyfills)
  3. Import browser adapter (@/common/adapter/browser)
  4. configService.initialize() — fetch /api/settings/client (TRƯỚC i18n/theme)
  5. Import i18n service
  6. registerPwa()
  7. Render AppProviders > Config > Main
     - AuthProvider → ThemeProvider → PreviewProvider → FeedbackProvider
  8. Main component:
     - Chờ auth ready
     - Prefetch /api/agents (seed SWR cache)
     - repairAllCronJobTimeZonesOnce()
     - Render Router > Layout > Sider
```

#### Provider Tree

```
AppProviders
  └── AuthProvider          (JWT auth state)
      └── ThemeProvider     (theme + color scheme)
          └── PreviewProvider (preview panel state)
              └── FeedbackProvider (feedback modal)
                  └── Config (Arco locale)
                      └── ConversationHistoryProvider
                          └── Layout (Sider + Router)
```

#### Routes (HashRouter)

| Path                     | Component                         | Mô tả                                                                                                                                                                       |
| ------------------------ | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/login`                 | LoginPage                         | Đăng nhập                                                                                                                                                                   |
| `/` (index)              | → `/guid`                         | Redirect về trang chủ                                                                                                                                                       |
| `/guid`                  | Guid                              | Trang chủ — chọn agent/model, tạo conversation                                                                                                                              |
| `/studio`                | Studio                            | Studio app — file hub kiểu WPS (mở file qua Universal Editor) + sub-app: Make Video (AI movie), Automation (workflow n8n-style), Repo Intelligence (IDE hiểu codebase), IDE |
| `/manager`               | Manager                           | Personal Manager — Tasks / Note / Schedule + AI (xem mục 30)                                                                                                                |
| `/conversation/:id`      | Conversation                      | Chat với agent                                                                                                                                                              |
| `/team/:id`              | TeamIndex                         | Team mode (chỉ khi `TEAM_MODE_ENABLED`, nếu không → redirect `/guid`)                                                                                                       |
| `/settings/model`        | ModeSettings                      | Quản lý AI providers                                                                                                                                                        |
| `/settings/assistants`   | AssistantSettings                 | Quản lý assistants                                                                                                                                                          |
| `/settings/agent`        | AgentSettings                     | Cấu hình agents                                                                                                                                                             |
| `/settings/capabilities` | CapabilitiesSettings              | Skills + Tools (MCP)                                                                                                                                                        |
| `/settings/skills-hub`   | → `?tab=skills`                   | Legacy redirect → `/settings/capabilities`                                                                                                                                  |
| `/settings/tools`        | → `?tab=tools`                    | Legacy redirect → `/settings/capabilities`                                                                                                                                  |
| `/settings/display`      | DisplaySettings                   | Giao diện, theme, font                                                                                                                                                      |
| `/settings/webui`        | WebuiSettings                     | WebUI + channels config                                                                                                                                                     |
| `/settings/pet`          | PetSettings                       | Desktop pet                                                                                                                                                                 |
| `/settings/resource`     | ResourceSettings                  | Resource Dashboard (ResourceCoordinator, desktop-only)                                                                                                                      |
| `/settings/company`      | CompanySettings (`pages/company`) | Agent Company (roles, rules, create-by-description; desktop-only)                                                                                                           |
| `/settings/browser`      | BrowserSettings (`pages/browser`) | Embedded Browser + web agent (tabs, agent mode, persona; desktop-only)                                                                                                      |
| `/settings/testing`      | TestingSettings (`pages/testing`) | Kiểm thử đa nền tảng (web chạy thật; Android/Windows unavailable; desktop-only)                                                                                             |
| `/settings/monitor`      | MonitorSettings (`pages/monitor`) | Bug monitor + auto-fix (bản vá đề xuất + báo cáo; desktop-only)                                                                                                             |
| `/settings/system`       | SystemSettings                    | System info, about                                                                                                                                                          |
| `/settings/about`        | SystemSettings                    | Alias của System info                                                                                                                                                       |
| `/settings`              | → `/settings/model`               | Redirect mặc định                                                                                                                                                           |
| `/settings/ext/:tabId`   | ExtensionSettingsPage             | Extension settings                                                                                                                                                          |
| `/test/components`       | ComponentsShowcase                | Component showcase (`packages/desktop/src/renderer/pages/TestShowcase.tsx`, dev)                                                                                            |
| `/scheduled`             | ScheduledTasksPage                | Danh sách cron jobs                                                                                                                                                         |
| `/scheduled/:job_id`     | TaskDetailPage                    | Chi tiết cron job                                                                                                                                                           |

> **Lưu ý:** KHÔNG có route `/settings/workspace`. Tính năng **Workspace (multi-sub-agent live frames)**
> (`renderer/pages/workspace/`) KHÔNG phải route riêng — nó được nhúng vào trong conversation qua
> `packages/desktop/src/renderer/pages/conversation/components/ConversationSurfaces.tsx` (dùng lại component `WorkspaceSurfaces`), seed bằng model của conversation
> đang mở. Xem mục 29.

---

### 5.3 Preload / IPC Bridge

File: `packages/desktop/src/preload/main.ts`

Preload expose `window.electronAPI` qua `contextBridge`:

```typescript
window.electronAPI = {
  emit(name, data)          // Gửi IPC invoke → main process
  on(callback)              // Lắng nghe IPC events từ main
  getPathForFile(file)      // Lấy absolute path của file drag-drop
  collectFeedbackLogs()     // Thu thập log files
  captureFeedbackScreenshot() // Chụp màn hình
}

window.__backendPort        // Port của aioncore (inject từ main)
window.__backendStartupFailed  // Boolean: backend có fail không
window.__backendStartupFailure // Chi tiết lỗi startup
```

**Tray events** được convert từ IPC → DOM CustomEvent:

- `tray:navigate-to-guid`
- `tray:navigate-to-conversation`
- `tray:open-about`
- `tray:pause-all-tasks`
- `tray:check-update`

**Adapter pattern:** `ADAPTER_BRIDGE_EVENT_KEY` là channel IPC duy nhất cho business logic.
Renderer gọi `window.electronAPI.emit(name, data)` → main process dispatch đến handler đúng.

### 5.4 Common (Shared)

```
common/
├── adapter/
│   ├── ipcBridge.ts        ← QUAN TRỌNG: toàn bộ API calls đến aioncore
│   ├── httpBridge.ts       ← HTTP/WS factory (httpGet, httpPost, wsEmitter...)
│   ├── browser.ts          ← Browser-side adapter setup
│   ├── main.ts             ← Main-process-side adapter setup
│   ├── apiModelMapper.ts   ← Map API response → frontend types
│   ├── teamMapper.ts       ← Map team API response
│   ├── workspaceMapper.ts  ← Map workspace file list
│   ├── searchMapper.ts     ← Map search results
│   ├── fileSnapshotMapper.ts ← Map file diff/snapshot
│   ├── registry.ts         ← Adapter registry
│   └── constant.ts         ← ADAPTER_BRIDGE_EVENT_KEY
├── api/
│   ├── ClientFactory.ts    ← Tạo AI API clients
│   ├── OpenAIRotatingClient.ts   ← OpenAI với key rotation
│   ├── AnthropicRotatingClient.ts
│   ├── GeminiRotatingClient.ts
│   ├── RotatingApiClient.ts      ← Base class
│   ├── ApiKeyManager.ts          ← Quản lý API keys
│   ├── ProtocolConverter.ts      ← Convert giữa các protocol
│   ├── OpenAI2AnthropicConverter.ts
│   └── OpenAI2GeminiConverter.ts
├── chat/
│   ├── chatLib.ts          ← Core chat types (IConfirmation...)
│   ├── atCommandParser.ts  ← Parse @file mentions
│   ├── imageGenCore.ts     ← Image generation logic
│   ├── normalizeToolCall.ts ← Normalize tool call format
│   ├── sideQuestion.ts     ← Side question handling
│   ├── approval/           ← Tool approval store
│   ├── document/           ← Document converter
│   ├── navigation/         ← Navigation interceptor
│   └── slash/              ← Slash command types
├── config/
│   ├── configService.ts    ← Client config service (GET/PUT /api/settings/client)
│   ├── configKeys.ts       ← Typed config key map
│   ├── configMigration.ts  ← Config migration logic
│   ├── storage.ts          ← QUAN TRỌNG: TChatConversation, IProvider, IStorageRefer
│   ├── storageKeys.ts      ← Storage key constants
│   ├── constants.ts        ← App constants (TEAM_MODE_ENABLED...)
│   ├── appEnv.ts           ← Environment detection
│   ├── i18n-config.json    ← Danh sách ngôn ngữ + modules
│   ├── i18n.ts             ← i18n config types
│   └── imageGenerationMcpEnv.ts
├── platform/
│   ├── IPlatformServices.ts      ← Interface
│   ├── ElectronPlatformServices.ts ← Electron implementation
│   ├── NodePlatformServices.ts   ← Node.js implementation
│   └── register-electron.ts     ← Đăng ký Electron platform
├── types/
│   ├── agent/              ← Agent types (assistantTypes, agentModes, hub...)
│   ├── channel/            ← Channel types
│   ├── codex/              ← Codex-specific types
│   ├── office/             ← Office preview/conversion types
│   ├── platform/           ← Electron types, ACP types, fileSnapshot
│   ├── provider/           ← Provider API types, speech types
│   └── team/               ← Team types, database types
├── update/                 ← Auto-update types
└── utils/
    ├── appConfig.ts        ← App config utilities
    ├── buildAgentConversationParams.ts
    ├── modelCapabilities.ts ← Model capability detection
    ├── platformConstants.ts ← Platform-specific constants
    ├── protocolDetector.ts  ← Detect AI provider protocol
    ├── urlValidation.ts
    └── utils.ts
```

---

## 6. Package: web-host

`packages/web-host/src/`

Library dùng chung bởi Electron app và web-cli để khởi động aioncore + static server.

```
web-host/src/
├── index.ts                  ← startWebHost() — entry point chính
├── backend-launcher.ts       ← BackendLifecycleManager, startBackend(), findAvailablePort()
├── static-server.ts          ← HTTP static server + reverse proxy /api/* → aioncore
├── agent-process-registry.ts ← Registry theo dõi agent processes
└── types.ts                  ← WebHostOptions, WebHostHandle
```

### Luồng `startWebHost(opts)`

```
1. startBackend() → spawn aioncore → chờ port
2. startStaticServer() → serve renderer build + proxy /api/* và /ws → aioncore
3. Return { port, backendPort, url, localUrl, networkUrl, lanIP, stop() }
```

### Chế độ hoạt động

| Chế độ               | Mô tả                                       |
| -------------------- | ------------------------------------------- |
| `ownBackend`         | web-host tự spawn aioncore                  |
| `useExistingBackend` | Dùng aioncore đang chạy (Electron đã spawn) |

---

## 7. Package: web-cli

`packages/web-cli/`

CLI binary `aionui-web` — chạy AionUi WebUI hoàn toàn không cần Electron (headless server mode).

```bash
aionui-web [--remote] [--port 25809]
```

Dùng `@aionui/web-host` để khởi động backend + static server.

---

## 8. Package: shared-scripts

`packages/shared-scripts/src/`

Script `packages/shared-scripts/src/prepare-aioncore.js` — download/copy aioncore binary vào đúng vị trí khi build.

---

## 9. Backend: aioncore (Rust)

aioncore là **Rust binary** được bundle cùng app. Đây là nơi chứa toàn bộ business logic.

### Vị trí binary

```
{resourcesPath}/bundled-aioncore/{platform}-{arch}/aioncore[.exe]
```

Ví dụ: `resources/bundled-aioncore/win32-x64/aioncore.exe`

### aioncore làm gì

- **HTTP REST API** trên port động (tìm port trống khi khởi động)
- **WebSocket** `/ws` — push events real-time đến renderer
- Quản lý conversations, messages, agents
- Chạy AI agent sessions (ACP protocol)
- Quản lý MCP servers
- File system operations
- Skills management
- Provider/model management
- Cron job scheduling
- Team mode orchestration
- WebUI server (channels: Telegram, Lark, DingTalk, WeChat)
- Authentication (JWT)
- Settings storage

### Giao tiếp với aioncore

Renderer và main process đều giao tiếp với aioncore qua **HTTP + WebSocket**:

```typescript
// httpBridge.ts — base URL resolution
function getBaseUrl(): string {
  // Electron: window.__backendPort (inject bởi preload)
  // WebUI browser: '' (same-origin, web-host proxy)
  // Main process: globalThis.__backendPort
  // Fallback: 13400
}
```

---

## 10. Database Schema

SQLite database, quản lý bởi aioncore. Schema version hiện tại: **26**.

### Tables

#### `users`

| Column        | Type        | Mô tả              |
| ------------- | ----------- | ------------------ |
| id            | TEXT PK     | UUID               |
| username      | TEXT UNIQUE | Tên đăng nhập      |
| email         | TEXT UNIQUE | Email              |
| password_hash | TEXT        | bcrypt hash        |
| avatar_path   | TEXT        | Đường dẫn avatar   |
| jwt_secret    | TEXT        | JWT signing secret |
| created_at    | INTEGER     | Unix timestamp ms  |
| updated_at    | INTEGER     | Unix timestamp ms  |
| last_login    | INTEGER     | Unix timestamp ms  |

#### `conversations`

| Column          | Type    | Mô tả                                                                                              |
| --------------- | ------- | -------------------------------------------------------------------------------------------------- |
| id              | TEXT PK | UUID                                                                                               |
| user_id         | TEXT FK | → users.id                                                                                         |
| name            | TEXT    | Tên conversation                                                                                   |
| type            | TEXT    | `acp`, `codex`, `aionrs`, `gemini`, `openclaw-gateway`, `remote`... (free-text, CHECK đã gỡ ở v22) |
| extra           | TEXT    | JSON — config theo type (workspace, backend, skills, mcp_servers...)                               |
| model           | TEXT    | JSON — provider + model info (chỉ aionrs)                                                          |
| status          | TEXT    | `pending`, `running`, `finished`                                                                   |
| source          | TEXT    | Nguồn tạo (v8): `aionui`/`telegram`/`lark`/`dingtalk`/extension...                                 |
| channel_chat_id | TEXT    | Chat id của channel để cô lập phiên theo chat (v14)                                                |
| created_at      | INTEGER |                                                                                                    |
| updated_at      | INTEGER |                                                                                                    |

#### `messages`

| Column          | Type    | Mô tả                                |
| --------------- | ------- | ------------------------------------ |
| id              | TEXT PK | UUID                                 |
| conversation_id | TEXT FK | → conversations.id                   |
| msg_id          | TEXT    | Message ID từ agent                  |
| type            | TEXT    | Loại message                         |
| content         | TEXT    | JSON content                         |
| position        | TEXT    | `left`, `right`, `center`, `pop`     |
| status          | TEXT    | `finish`, `pending`, `error`, `work` |
| hidden          | INTEGER | 0/1 — ẩn message khỏi UI (v22)       |
| created_at      | INTEGER |                                      |

#### `teams`

| Column         | Type    | Mô tả                             |
| -------------- | ------- | --------------------------------- |
| id             | TEXT PK | UUID                              |
| user_id        | TEXT FK | → users.id                        |
| name           | TEXT    | Tên team                          |
| workspace      | TEXT    | Thư mục làm việc chung            |
| workspace_mode | TEXT    | `shared`                          |
| lead_agent_id  | TEXT    | ID của Leader agent               |
| agents         | TEXT    | JSON array — danh sách agents     |
| session_mode   | TEXT    | Chế độ quyền phiên của team (v23) |
| created_at     | INTEGER |                                   |
| updated_at     | INTEGER |                                   |

#### `mailbox` (Team messaging)

| Column        | Type    | Mô tả                                      |
| ------------- | ------- | ------------------------------------------ |
| id            | TEXT PK |                                            |
| team_id       | TEXT FK | → teams.id                                 |
| to_agent_id   | TEXT    | Agent nhận                                 |
| from_agent_id | TEXT    | Agent gửi                                  |
| type          | TEXT    | `message`                                  |
| content       | TEXT    | Nội dung                                   |
| summary       | TEXT    | Tóm tắt                                    |
| read          | INTEGER | 0/1                                        |
| files         | TEXT    | JSON array — đường dẫn file đính kèm (v25) |
| created_at    | INTEGER |                                            |

#### `team_tasks`

| Column      | Type    | Mô tả                                      |
| ----------- | ------- | ------------------------------------------ |
| id          | TEXT PK |                                            |
| team_id     | TEXT FK | → teams.id                                 |
| subject     | TEXT    | Tiêu đề task                               |
| description | TEXT    | Mô tả                                      |
| status      | TEXT    | `pending`, `in_progress`, `done`, `failed` |
| owner       | TEXT    | Agent ID đang làm                          |
| blocked_by  | TEXT    | JSON array — task IDs chặn                 |
| blocks      | TEXT    | JSON array — task IDs bị chặn              |
| metadata    | TEXT    | JSON                                       |
| created_at  | INTEGER |                                            |
| updated_at  | INTEGER |                                            |

#### Các bảng khác (do migrations tạo)

Ngoài 6 bảng lõi ở trên, schema còn có các bảng sau (xem `packages/desktop/src/process/services/database/migrations.ts`):

| Bảng                      | Migration | Mục đích                                                                                |
| ------------------------- | --------- | --------------------------------------------------------------------------------------- |
| `assistant_plugins`       | v7        | Cấu hình channel plugin (telegram/slack/discord/lark/dingtalk... — CHECK gỡ ở v15)      |
| `assistant_users`         | v7        | Whitelist user được phép tương tác qua channel                                          |
| `assistant_sessions`      | v7 (+v14) | Phiên user theo channel (`chat_id` thêm ở v14)                                          |
| `assistant_pairing_codes` | v7        | Mã ghép đôi đang chờ duyệt                                                              |
| `cron_jobs`               | v9        | Scheduled tasks (cron); thêm `execution_mode`/`agent_config` (v22), `description` (v24) |
| `remote_agents`           | v16       | Remote AionUi agents (+ device identity v17, `allow_insecure` v18)                      |
| `acp_session`             | v26       | Lưu trạng thái phiên ACP để suspend/resume qua restart                                  |

> **Lưu ý:** `CURRENT_DB_VERSION = 26`. Mỗi migration là một bước trong `ALL_MIGRATIONS` (v1→v26). Từ
> v22, CHECK constraint trên `conversations.type` đã được gỡ → thêm agent type mới chỉ cần đổi TypeScript,
> không cần migration DB.

### Indexes quan trọng

```sql
idx_conversations_user_updated  ON conversations(user_id, updated_at DESC)
idx_messages_conversation_created ON messages(conversation_id, created_at)
idx_mailbox_to ON mailbox(team_id, to_agent_id, read)
idx_tasks_team ON team_tasks(team_id, status)
```

---

## 11. API Surface (HTTP + WebSocket)

Tất cả calls đi qua `packages/desktop/src/common/adapter/ipcBridge.ts`.

### HTTP Endpoints (aioncore REST API)

#### Conversations

| Method | Path                                                    | Mô tả                      |
| ------ | ------------------------------------------------------- | -------------------------- |
| POST   | `/api/conversations`                                    | Tạo conversation mới       |
| GET    | `/api/conversations/:id`                                | Lấy conversation           |
| PATCH  | `/api/conversations/:id`                                | Cập nhật conversation      |
| DELETE | `/api/conversations/:id`                                | Xóa conversation           |
| POST   | `/api/conversations/:id/messages`                       | Gửi message                |
| POST   | `/api/conversations/:id/cancel`                         | Dừng generation            |
| POST   | `/api/conversations/:id/reset`                          | Reset conversation         |
| GET    | `/api/conversations/:id/confirmations`                  | Lấy pending confirmations  |
| POST   | `/api/conversations/:id/confirmations/:call_id/confirm` | Confirm tool call          |
| GET    | `/api/conversations/:id/artifacts`                      | Lấy artifacts              |
| GET    | `/api/conversations/:id/workspace`                      | Duyệt workspace files      |
| GET    | `/api/conversations/:id/slash-commands`                 | Lấy slash commands         |
| GET    | `/api/conversations/active-count`                       | Số conversations đang chạy |

#### Agents

| Method | Path                           | Mô tả                   |
| ------ | ------------------------------ | ----------------------- |
| GET    | `/api/agents`                  | Danh sách agents có sẵn |
| POST   | `/api/agents/refresh`          | Refresh custom agents   |
| POST   | `/api/agents/custom`           | Tạo custom agent        |
| PUT    | `/api/agents/custom/:id`       | Cập nhật custom agent   |
| DELETE | `/api/agents/custom/:id`       | Xóa custom agent        |
| POST   | `/api/agents/health-check`     | Kiểm tra agent health   |
| GET    | `/api/conversations/:id/mode`  | Lấy agent mode          |
| PUT    | `/api/conversations/:id/mode`  | Đặt agent mode          |
| GET    | `/api/conversations/:id/model` | Lấy model hiện tại      |
| PUT    | `/api/conversations/:id/model` | Đặt model               |

#### Providers (AI Platforms)

| Method | Path                             | Mô tả                  |
| ------ | -------------------------------- | ---------------------- |
| GET    | `/api/providers`                 | Danh sách providers    |
| POST   | `/api/providers`                 | Tạo provider           |
| PUT    | `/api/providers/:id`             | Cập nhật provider      |
| DELETE | `/api/providers/:id`             | Xóa provider           |
| POST   | `/api/providers/:id/models`      | Fetch model list       |
| POST   | `/api/providers/fetch-models`    | Anonymous fetch models |
| POST   | `/api/providers/detect-protocol` | Detect API protocol    |

#### MCP Servers

| Method | Path                          | Mô tả                 |
| ------ | ----------------------------- | --------------------- |
| GET    | `/api/mcp/servers`            | Danh sách MCP servers |
| POST   | `/api/mcp/servers`            | Thêm MCP server       |
| PUT    | `/api/mcp/servers/:id`        | Cập nhật              |
| DELETE | `/api/mcp/servers/:id`        | Xóa                   |
| POST   | `/api/mcp/servers/:id/toggle` | Bật/tắt               |
| POST   | `/api/mcp/test-connection`    | Test kết nối          |
| POST   | `/api/mcp/oauth/login`        | OAuth login           |

#### File System

| Method | Path                   | Mô tả                    |
| ------ | ---------------------- | ------------------------ |
| POST   | `/api/fs/dir`          | Duyệt thư mục            |
| POST   | `/api/fs/list`         | Liệt kê files phẳng      |
| POST   | `/api/fs/read`         | Đọc file                 |
| POST   | `/api/fs/write`        | Ghi file                 |
| POST   | `/api/fs/remove`       | Xóa file/dir             |
| POST   | `/api/fs/rename`       | Đổi tên                  |
| POST   | `/api/fs/copy`         | Copy files               |
| POST   | `/api/fs/zip`          | Tạo zip                  |
| POST   | `/api/fs/image-base64` | Đọc ảnh dạng base64      |
| POST   | `/api/fs/snapshot/*`   | Git-based file snapshots |
| POST   | `/api/fs/watch/start`  | Bắt đầu watch file       |

#### Skills

| Method | Path                                | Mô tả                   |
| ------ | ----------------------------------- | ----------------------- |
| GET    | `/api/skills`                       | Danh sách skills        |
| POST   | `/api/skills/import`                | Import skill            |
| DELETE | `/api/skills/:name`                 | Xóa skill               |
| POST   | `/api/skills/materialize-for-agent` | Inject skills vào agent |

#### Settings

| Method | Path                   | Mô tả                      |
| ------ | ---------------------- | -------------------------- |
| GET    | `/api/settings/client` | Lấy tất cả client settings |
| PUT    | `/api/settings/client` | Cập nhật settings          |

#### Assistants

| Method | Path                     | Mô tả                |
| ------ | ------------------------ | -------------------- |
| GET    | `/api/assistants`        | Danh sách assistants |
| POST   | `/api/assistants`        | Tạo assistant        |
| PUT    | `/api/assistants/:id`    | Cập nhật             |
| DELETE | `/api/assistants/:id`    | Xóa                  |
| POST   | `/api/assistants/import` | Import assistants    |

#### Teams

| Method | Path                                  | Mô tả                         |
| ------ | ------------------------------------- | ----------------------------- |
| GET    | `/api/teams`                          | Danh sách teams (`?user_id=`) |
| POST   | `/api/teams`                          | Tạo team                      |
| DELETE | `/api/teams/:id`                      | Xóa team                      |
| PATCH  | `/api/teams/:id/name`                 | Đổi tên team (renameTeam)     |
| POST   | `/api/teams/:id/session`              | Bắt đầu/đảm bảo phiên team    |
| DELETE | `/api/teams/:id/session`              | Dừng phiên team               |
| POST   | `/api/teams/:id/session-mode`         | Đặt session mode              |
| POST   | `/api/teams/:id/agents`               | Thêm agent (slot)             |
| DELETE | `/api/teams/:id/agents/:slot_id`      | Xóa agent (slot)              |
| PATCH  | `/api/teams/:id/agents/:slot_id/name` | Đổi tên agent                 |

> **Lưu ý:** KHÔNG có `PUT /api/teams/:id`. Cập nhật team đi qua các sub-resource ở trên (đối chiếu
> `packages/desktop/src/common/adapter/ipcBridge.ts` mục `team`).

#### Cron Jobs

| Method | Path                 | Mô tả               |
| ------ | -------------------- | ------------------- |
| GET    | `/api/cron/jobs`     | Danh sách cron jobs |
| POST   | `/api/cron/jobs`     | Tạo cron job        |
| PUT    | `/api/cron/jobs/:id` | Cập nhật            |
| DELETE | `/api/cron/jobs/:id` | Xóa                 |

### WebSocket Events (`/ws`)

| Event                            | Hướng         | Mô tả                                           |
| -------------------------------- | ------------- | ----------------------------------------------- |
| `message.stream`                 | server→client | Streaming AI response                           |
| `turn.completed`                 | server→client | AI turn hoàn thành                              |
| `conversation.listChanged`       | server→client | Danh sách conversation thay đổi                 |
| `conversation.artifact`          | server→client | Artifact mới (file được tạo)                    |
| `confirmation.add`               | server→client | Tool call cần confirm                           |
| `confirmation.update`            | server→client | Confirmation state thay đổi                     |
| `confirmation.remove`            | server→client | Confirmation đã xử lý                           |
| `fileWatch.fileChanged`          | server→client | File được thay đổi                              |
| `fileStream.contentUpdate`       | server→client | File content update real-time                   |
| `workspaceOfficeWatch.fileAdded` | server→client | Office file mới trong workspace                 |
| `team.*`                         | server→client | Team events (agent spawned, status, message...) |

---

## 12. Renderer: Pages & Routing

### Conversation Page (`pages/conversation/`)

Page phức tạp nhất — toàn bộ chat UI.

```
conversation/
├── index.tsx                   ← Entry
├── components/
│   ├── ChatConversation.tsx    ← Container chính
│   ├── ChatHistory.tsx         ← Lịch sử messages
│   ├── ChatSlider.tsx          ← Resizable split panel
│   ├── ChatTitleEditor.tsx     ← Inline title editing
│   ├── ConversationSkillsIndicator.tsx ← Skills đang active
│   ├── SkillRuleGenerator.tsx  ← Tạo skill rules
│   ├── WorkspaceCollapse.tsx   ← Collapse workspace panel
│   ├── ChatLayout/             ← Layout wrapper
│   └── ConversationTitleMinimap/ ← Title + minimap
├── GroupedHistory/             ← Sidebar conversation list
│   ├── index.tsx               ← Grouped by date
│   ├── ConversationRow.tsx     ← Single conversation item
│   ├── SortableConversationRow.tsx ← Drag-to-reorder
│   ├── ConversationSearchPopover.tsx ← Search conversations
│   └── DragOverlayContent.tsx
├── Messages/                   ← Message list rendering
│   ├── MessageList.tsx         ← Virtualized list (react-virtuoso)
│   ├── MessageFileChanges.tsx  ← File diff display
│   ├── artifacts.tsx           ← Artifact rendering
│   ├── acp/                    ← ACP-specific message components
│   └── components/             ← Message bubble components
├── platforms/                  ← Platform-specific conversation logic
│   ├── acp/                    ← ACP (Claude Code, Codex, etc.)
│   ├── aionrs/                 ← Built-in Aion agent
│   ├── gemini/                 ← Gemini native
│   ├── nanobot/                ← Nanobot agent
│   ├── openclaw/               ← OpenClaw gateway
│   └── remote/                 ← Remote agents
├── Preview/                    ← File preview panel
│   ├── components/             ← Preview renderers (PDF, code, image...)
│   ├── context/PreviewContext.tsx ← Preview state
│   ├── hooks/                  ← Preview hooks
│   ├── types.ts
│   └── README.en.md / README.cn.md
├── Workspace/                  ← Workspace file browser
│   ├── index.tsx
│   ├── components/             ← File tree, file actions
│   ├── hooks/
│   └── README.en.md / README.cn.md
├── hooks/                      ← Page-private hooks
│   ├── useConversationAgents.ts
│   ├── useLayoutConstraints.ts
│   ├── usePreviewAutoCollapse.ts
│   └── useTitleRename.ts
└── utils/
    ├── createConversationParams.ts ← Build params khi tạo conversation
    ├── detectPlatform.ts           ← Detect conversation type
    ├── conversationCache.ts        ← Cache conversation data
    └── warmupConversation.ts       ← Warmup trước khi chat
```

### Guid Page (`pages/guid/`)

Trang chủ — nơi user chọn agent, model, workspace và tạo conversation mới.

### Settings Pages (`pages/settings/`)

```
settings/
├── AgentSettings/          ← Cấu hình agents (ACP, custom agents)
├── AssistantSettings/      ← Quản lý assistants
├── DisplaySettings/        ← Theme, font, CSS customization
├── ResourceSettings/       ← Resource Dashboard (ResourceCoordinator)
├── ToolsSettings/          ← MCP tools (đã merge vào CapabilitiesSettings)
├── components/             ← Shared settings components (gồm SettingsSider)
├── CapabilitiesSettings.tsx ← Skills + Tools (merged page)
├── ModeSettings.tsx        ← AI providers/models
├── SystemSettings.tsx      ← System info, about, diagnostics
├── WebuiSettings.tsx       ← WebUI + channels (Telegram, Lark...)
├── PetSettings.tsx         ← Desktop pet config
├── ExtensionSettingsPage.tsx ← Extension-specific settings
└── SkillsHubSettings.tsx   ← (redirect → /settings/capabilities?tab=skills)
```

> Các trang Tomni Agentic dùng đường dẫn `/settings/*` nhưng **component nằm ngoài** `pages/settings/`:
> Company → `pages/company/`, Browser → `pages/browser/`, Testing → `pages/testing/`,
> Monitor → `pages/monitor/` (xem "Tomni Agentic Pages" ở trên).

### Cron Page (`pages/cron/`)

```
cron/
├── ScheduledTasksPage/     ← Danh sách + tạo cron jobs
├── components/             ← CronJobCard, CronForm...
├── cronUtils.ts            ← Parse/format cron expressions
├── useCronJobs.ts          ← SWR hook cho cron jobs
└── repairCronJobTimeZone.ts ← One-shot timezone repair
```

### Team Page (`pages/team/`)

```
team/
├── TeamPage.tsx            ← Team dashboard
├── components/             ← TeamAgentCard, TeamTaskBoard...
└── hooks/                  ← useTeam, useTeamAgents...
```

### Tomni Agentic Pages (desktop-only)

Các page mới phục vụ spec Tomni Agentic (xem mục 29). Mỗi page là một `pages/<feature>/` với `index.tsx`
làm entry và được lazy-load trong `packages/desktop/src/renderer/components/layout/Router.tsx`:

| Page      | Thư mục            | Route                | Mô tả                                                                                                                                                                                                                  |
| --------- | ------------------ | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser   | `pages/browser/`   | `/settings/browser`  | URL bar + `AgentChatPanel` (web agent), `BrowserToolbar`                                                                                                                                                               |
| Company   | `pages/company/`   | `/settings/company`  | Agent Company: roles/rules, dựng công ty từ mô tả, **Manager popup** — chế độ Pipeline (làm thật, đệ quy, CLI agent) + Conversation (diễn nhanh); `pipeline/` + `manager/`                                             |
| Testing   | `pages/testing/`   | `/settings/testing`  | `NewSessionPanel` + danh sách phiên/báo cáo kiểm thử                                                                                                                                                                   |
| Monitor   | `pages/monitor/`   | `/settings/monitor`  | `MonitorPage`: bản vá đề xuất + báo cáo lỗi (`useMonitorState`)                                                                                                                                                        |
| Studio    | `pages/studio/`    | `/studio`            | File hub WPS-style (`StudioPage`/`StudioDashboard`) + sub-app `automation/` (workflow n8n-style, React Flow), `ide/` (IDE hợp nhất: `IdeWorkspace` — Files/Understand/Chat/Wiki), `makevideo/` (AI movie/anime, cloud) |
| Editor    | `pages/editor/`    | (nhúng trong Studio) | `UniversalEditor` + `editorRegistry` + `adapters/`                                                                                                                                                                     |
| Workspace | `pages/workspace/` | (nhúng trong chat)   | `WorkspaceSurfaces` — multi-sub-agent live frames                                                                                                                                                                      |
| Manager   | `pages/manager/`   | `/manager`           | Personal Manager: Tasks / Note / Schedule (xem mục 30)                                                                                                                                                                 |

> **Lưu ý route:** Browser/Company/Testing/Monitor dùng route `/settings/*`, còn **Studio** (`/studio`)
> và **Manager** (`/manager`) là **app top-level** (nav riêng ở Sider, không nằm trong Settings).

```
studio/
├── index.tsx               ← Entry (default export Studio)
├── StudioPage.tsx          ← Dashboard chính
├── components/             ← StudioDashboard, StudioEditorView,
│                              DocAssistantPanel, StudioFileRow, CreateFileModal
├── hooks/                  ← useStudioFiles, useDocAssistant, useFileCreator
├── studioStorage.ts        ← Recent/Starred (localStorage)
├── studioChatClient.ts     ← Client gọi kênh studio.chat
├── fileKindMeta.tsx / relativeTime.ts / extractCodeBlock.ts

editor/
├── UniversalEditor.tsx     ← Editor đa năng (Monaco + adapter theo loại file)
├── editorRegistry.ts       ← Phân loại file → adapter
├── adapterRegistry.tsx     ← Đăng ký adapter UI
├── adapters/               ← Adapter cho từng loại file (gồm OnlyOfficeEditor, studioDocxClient...)
└── hooks/                  ← useUniversalEditor, useEditorFile...

workspace/
├── WorkspaceSurfaces.tsx   ← Composer + grid live-frame (nhúng vào conversation)
├── useWorkspaceRun.ts      ← Start run + subscribe workspace.event
├── workspaceBridgeClient.ts← Client kênh workspace.*
├── constants.ts            ← parseSurfaceSpecs, model storage helpers
└── components/             ← SurfaceGrid, SurfaceFrame, BrowserSurfaceView,
                               EditorSurfaceView, WorkspaceComposer

manager/
├── index.tsx               ← Entry (default export Manager)
├── ManagerPage.tsx         ← 3 tab: Tasks / Notes / Schedule (Arco Tabs)
├── useManagerStore.ts      ← Store hook (status loading/ready/unavailable)
├── managerBridgeClient.ts  ← Client kênh manager.* + managerStrings.ts
├── tasks/                  ← TasksView, TodayPanel, TaskCard/Editor, AiCreateTasks, DraftReview
├── notes/                  ← NotesView (Daily/Learn/Data), NoteCard/Editor, ResearchModal, wikiLinks
└── schedule/               ← ScheduleView, DayWeekGrid, EventCard/Editor, ImportFromImage, OptimizePanel
```

---

## 13. Renderer: Components

### `components/base/` — UI Primitives

| Component          | Mô tả                                       |
| ------------------ | ------------------------------------------- |
| `AionModal`        | Modal wrapper (Arco Modal + custom styling) |
| `AionSelect`       | Select wrapper                              |
| `AionScrollArea`   | Scroll area với custom scrollbar            |
| `AionCollapse`     | Collapsible section                         |
| `AionSteps`        | Step indicator                              |
| `FeedbackButton`   | Nút gửi feedback                            |
| `FileChangesPanel` | Hiển thị file diff changes                  |
| `ModalWrapper`     | HOC cho modal                               |
| `StepsWrapper`     | HOC cho steps                               |

### `components/layout/`

| Component                                                               | Mô tả                                  |
| ----------------------------------------------------------------------- | -------------------------------------- |
| `packages/desktop/src/renderer/components/layout/Layout.tsx`            | App layout chính (Sider + content)     |
| `packages/desktop/src/renderer/components/layout/Router.tsx`            | HashRouter + routes                    |
| `Sider/`                                                                | Sidebar: conversation list, navigation |
| `Titlebar/`                                                             | Custom title bar (Windows/Linux)       |
| `packages/desktop/src/renderer/components/layout/AppLoader.tsx`         | Loading spinner                        |
| `packages/desktop/src/renderer/components/layout/WindowControls.tsx`    | Min/max/close buttons                  |
| `packages/desktop/src/renderer/components/layout/FlexFullContainer.tsx` | Full-height flex container             |
| `packages/desktop/src/renderer/components/layout/PwaPullToRefresh.tsx`  | PWA pull-to-refresh                    |

### `components/chat/`

| Component                                                              | Mô tả                                                |
| ---------------------------------------------------------------------- | ---------------------------------------------------- |
| `SendBox/`                                                             | Input box gửi message (textarea, file attach, voice) |
| `AtFileMenu/`                                                          | @file mention dropdown                               |
| `BtwOverlay/`                                                          | Between-message overlay                              |
| `MobileActionSheet/`                                                   | Mobile action sheet                                  |
| `packages/desktop/src/renderer/components/chat/SlashCommandMenu.tsx`   | `/command` dropdown                                  |
| `packages/desktop/src/renderer/components/chat/SpeechInputButton.tsx`  | Voice input button                                   |
| `packages/desktop/src/renderer/components/chat/ThoughtDisplay.tsx`     | Hiển thị AI thinking process                         |
| `packages/desktop/src/renderer/components/chat/CommandQueuePanel.tsx`  | Queue của pending commands                           |
| `packages/desktop/src/renderer/components/chat/EmojiPicker.tsx`        | Emoji picker                                         |
| `packages/desktop/src/renderer/components/chat/CollapsibleContent.tsx` | Collapsible message content                          |

### `components/agent/`

| Component                                                                   | Mô tả                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/desktop/src/renderer/components/agent/AgentModeSelector.tsx`      | Chọn agent mode (YOLO, auto-approve...)                                                                                                                                                                                                                                                                                                                                       |
| `packages/desktop/src/renderer/components/agent/AgentSetupCard.tsx`         | Card setup agent mới                                                                                                                                                                                                                                                                                                                                                          |
| `packages/desktop/src/renderer/components/agent/AgentBadge.tsx`             | Badge hiển thị agent type                                                                                                                                                                                                                                                                                                                                                     |
| `packages/desktop/src/renderer/components/agent/AcpModelSelector.tsx`       | Chọn model cho ACP agents                                                                                                                                                                                                                                                                                                                                                     |
| `packages/desktop/src/renderer/components/agent/ContextUsageIndicator.tsx`  | Hiển thị context window usage                                                                                                                                                                                                                                                                                                                                                 |
| `packages/desktop/src/renderer/components/agent/ChannelConflictWarning.tsx` | Cảnh báo channel conflict                                                                                                                                                                                                                                                                                                                                                     |
| `packages/desktop/src/renderer/components/agent/MarqueePillLabel.tsx`       | Animated pill label                                                                                                                                                                                                                                                                                                                                                           |
| `QuickActive/`                                                              | "Quick Active" dock ở đáy chat/team/company — sổ ra trang đang hoạt động (tab Browser đang mở, Company đã biết) và đi thẳng tới đó. `packages/desktop/src/renderer/components/agent/QuickActive/useActiveSurfaces.ts` gom dữ liệu read-only qua bridge client (degrade khi chưa wire); hand-off chọn tab/company qua `requestActiveTab`/`requestActiveCompany`. Desktop-only. |

### `components/media/`

| Component                                                               | Mô tả                                     |
| ----------------------------------------------------------------------- | ----------------------------------------- |
| `packages/desktop/src/renderer/components/media/FilePreview.tsx`        | Preview file (dispatch đến renderer đúng) |
| `packages/desktop/src/renderer/components/media/LocalImageView.tsx`     | Hiển thị ảnh local                        |
| `packages/desktop/src/renderer/components/media/Diff2Html.tsx`          | Hiển thị git diff                         |
| `packages/desktop/src/renderer/components/media/FileAttachButton.tsx`   | Nút đính kèm file                         |
| `packages/desktop/src/renderer/components/media/HorizontalFileList.tsx` | Danh sách files ngang                     |
| `packages/desktop/src/renderer/components/media/UploadProgressBar.tsx`  | Progress bar upload                       |
| `packages/desktop/src/renderer/components/media/WebviewHost.tsx`        | Electron webview wrapper                  |

### `components/Markdown/`

| Component                                                            | Mô tả                                  |
| -------------------------------------------------------------------- | -------------------------------------- |
| `index.tsx`                                                          | Markdown renderer chính                |
| `packages/desktop/src/renderer/components/Markdown/CodeBlock.tsx`    | Code block với syntax highlight + copy |
| `packages/desktop/src/renderer/components/Markdown/MermaidBlock.tsx` | Mermaid diagram renderer               |
| `packages/desktop/src/renderer/components/Markdown/ShadowView.tsx`   | Shadow DOM cho HTML isolation          |
| `packages/desktop/src/renderer/components/Markdown/markdownUtils.ts` | Utilities (detect language, etc.)      |

### `components/settings/`

| Component                                                                       | Mô tả                  |
| ------------------------------------------------------------------------------- | ---------------------- |
| `SettingsModal/`                                                                | Settings modal wrapper |
| `packages/desktop/src/renderer/components/settings/ThemeSwitcher.tsx`           | Chọn theme             |
| `packages/desktop/src/renderer/components/settings/LanguageSwitcher.tsx`        | Chọn ngôn ngữ          |
| `packages/desktop/src/renderer/components/settings/FontSizeControl.tsx`         | Điều chỉnh font size   |
| `packages/desktop/src/renderer/components/settings/UpdateModal.tsx`             | Modal cập nhật app     |
| `packages/desktop/src/renderer/components/settings/DirectorySelectionModal.tsx` | Chọn thư mục           |

### `components/` — khác (top-level + subfolder)

| Mục                                                        | Mô tả                                                                                                                                                                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `devtools/`                                                | `packages/desktop/src/renderer/components/devtools/DevConsoleOverlay.tsx` — overlay console dev (in-app)                                                                                                     |
| `workspace/`                                               | `packages/desktop/src/renderer/components/workspace/WorkspaceFolderSelect.tsx` + `packages/desktop/src/renderer/components/workspace/recentWorkspaces.ts` — chọn thư mục workspace (KHÁC `pages/workspace/`) |
| `packages/desktop/src/renderer/components/IconParkHOC.tsx` | HOC bọc icon @icon-park (chuẩn hóa props/size)                                                                                                                                                               |
| `packages/desktop/src/renderer/components/ShimmerText.tsx` | Text hiệu ứng shimmer (loading/placeholder)                                                                                                                                                                  |

---

## 14. Renderer: Hooks

### `hooks/context/` — Global Contexts

| Hook/Context                                                                 | Mô tả                                                             |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/desktop/src/renderer/hooks/context/AuthContext.tsx`                | JWT auth state (`status: checking/authenticated/unauthenticated`) |
| `packages/desktop/src/renderer/hooks/context/ThemeContext.tsx`               | Theme + color scheme                                              |
| `ConversationContext.tsx`                                                    | Current conversation state                                        |
| `packages/desktop/src/renderer/hooks/context/ConversationHistoryContext.tsx` | Conversation list + pagination                                    |
| `packages/desktop/src/renderer/hooks/context/FeedbackContext.tsx`            | Feedback modal state                                              |
| `packages/desktop/src/renderer/hooks/context/LayoutContext.tsx`              | Layout dimensions                                                 |
| `packages/desktop/src/renderer/hooks/context/NavigationHistoryContext.tsx`   | Navigation history                                                |

### `hooks/agent/`

| Hook                                                                       | Mô tả                        |
| -------------------------------------------------------------------------- | ---------------------------- |
| `packages/desktop/src/renderer/hooks/agent/useAgents.ts`                   | Danh sách agents (SWR)       |
| `packages/desktop/src/renderer/hooks/agent/useHubAgents.ts`                | Hub agents                   |
| `packages/desktop/src/renderer/hooks/agent/useModelProviderList.ts`        | Danh sách providers + models |
| `packages/desktop/src/renderer/hooks/agent/useAgentReadinessCheck.ts`      | Kiểm tra agent sẵn sàng      |
| `packages/desktop/src/renderer/hooks/agent/useAgentModesForBackend.ts`     | Agent modes theo backend     |
| `packages/desktop/src/renderer/hooks/agent/useAcpModelInfo.ts`             | ACP model info               |
| `packages/desktop/src/renderer/hooks/agent/useGoogleAuthModels.ts`         | Google auth models           |
| `packages/desktop/src/renderer/hooks/agent/usePresetAssistantInfo.ts`      | Preset assistant metadata    |
| `packages/desktop/src/renderer/hooks/agent/useConfigModelListWithImage.ts` | Models hỗ trợ image          |
| `packages/desktop/src/renderer/hooks/agent/useModeModeList.ts`             | Danh sách model theo mode    |

### `hooks/assistant/`

| Hook                                                                  | Mô tả                      |
| --------------------------------------------------------------------- | -------------------------- |
| `packages/desktop/src/renderer/hooks/assistant/useAssistantList.ts`   | Danh sách assistants (SWR) |
| `packages/desktop/src/renderer/hooks/assistant/useAssistantEditor.ts` | State sửa/tạo assistant    |
| `packages/desktop/src/renderer/hooks/assistant/useDetectedAgents.ts`  | Agents (CLI) tự phát hiện  |

### `hooks/config/`

| Hook                                                      | Mô tả                       |
| --------------------------------------------------------- | --------------------------- |
| `packages/desktop/src/renderer/hooks/config/useConfig.ts` | Đọc/ghi client config (SWR) |

### `hooks/chat/`

| Hook                                                                    | Mô tả                        |
| ----------------------------------------------------------------------- | ---------------------------- |
| `packages/desktop/src/renderer/hooks/chat/useSendBoxDraft.ts`           | Draft message state          |
| `packages/desktop/src/renderer/hooks/chat/useSendBoxFiles.ts`           | Files đính kèm               |
| `useAutoScroll.ts`                                                      | Auto-scroll to bottom        |
| `packages/desktop/src/renderer/hooks/chat/useAutoTitle.ts`              | Tự động đặt tên conversation |
| `packages/desktop/src/renderer/hooks/chat/useSlashCommands.ts`          | Slash command list           |
| `packages/desktop/src/renderer/hooks/chat/useSlashCommandController.ts` | Slash command UI state       |
| `packages/desktop/src/renderer/hooks/chat/useCompositionInput.ts`       | IME composition handling     |
| `packages/desktop/src/renderer/hooks/chat/useTypingAnimation.ts`        | Typing indicator             |
| `packages/desktop/src/renderer/hooks/chat/useInitialMessage.ts`         | Initial message từ deep link |
| `packages/desktop/src/renderer/hooks/chat/useInputFocusRing.ts`         | Focus ring cho input         |

### `hooks/file/`

| Hook                                                                              | Mô tả                                     |
| --------------------------------------------------------------------------------- | ----------------------------------------- |
| `packages/desktop/src/renderer/hooks/file/useDragUpload.ts`                       | Drag-and-drop file upload                 |
| `packages/desktop/src/renderer/hooks/file/useOpenFileSelector.ts`                 | Native file picker                        |
| `packages/desktop/src/renderer/hooks/file/usePasteService.ts`                     | Paste image/file                          |
| `packages/desktop/src/renderer/hooks/file/useUploadState.ts`                      | Upload progress state                     |
| `packages/desktop/src/renderer/hooks/file/useConversationExport.tsx`              | Export conversation                       |
| `packages/desktop/src/renderer/hooks/file/useDirectorySelection.tsx`              | Chọn thư mục                              |
| `packages/desktop/src/renderer/hooks/file/usePreviewLauncher.ts`                  | Mở file trong preview panel               |
| `packages/desktop/src/renderer/hooks/file/useDiffPreviewHandlers.ts`              | Diff preview handlers                     |
| `packages/desktop/src/renderer/hooks/file/useAutoPreviewOfficeFiles.ts`           | Auto-preview office files                 |
| `packages/desktop/src/renderer/hooks/file/useWorkspaceSelector.ts`                | Chọn workspace                            |
| `packages/desktop/src/renderer/hooks/file/useAbortUploadsOnConversationChange.ts` | Hủy upload đang chạy khi đổi conversation |

### `hooks/mcp/`

| Hook                                                          | Mô tả                       |
| ------------------------------------------------------------- | --------------------------- |
| `packages/desktop/src/renderer/hooks/mcp/useMcpServers.ts`    | Danh sách MCP servers (SWR) |
| `packages/desktop/src/renderer/hooks/mcp/useMcpServerCRUD.ts` | CRUD operations             |
| `packages/desktop/src/renderer/hooks/mcp/useMcpConnection.ts` | Test kết nối                |
| `packages/desktop/src/renderer/hooks/mcp/useMcpModal.ts`      | MCP modal state             |
| `packages/desktop/src/renderer/hooks/mcp/useMcpOAuth.ts`      | OAuth flow                  |
| `catalog.ts`                                                  | MCP server catalog          |
| `index.ts`                                                    | Barrel export hooks MCP     |
| `packages/desktop/src/renderer/hooks/mcp/messageQueue.ts`     | Message queue cho MCP       |

### `hooks/system/`

| Hook                                                                             | Mô tả                                                                           |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `packages/desktop/src/renderer/hooks/system/useTheme.ts`                         | Theme management                                                                |
| `packages/desktop/src/renderer/hooks/system/useDeepLink.ts`                      | Handle aionui:// deep links + open-url (mở web URL từ OS vào tab Browser nhúng) |
| `packages/desktop/src/renderer/hooks/system/usePwaMode.ts`                       | PWA detection                                                                   |
| `packages/desktop/src/renderer/hooks/system/useSpeechInput.ts`                   | Speech-to-text                                                                  |
| `packages/desktop/src/renderer/hooks/system/useNotificationClick.ts`             | Desktop notification click                                                      |
| `packages/desktop/src/renderer/hooks/system/useProtocolDetection.ts`             | Detect AI protocol                                                              |
| `packages/desktop/src/renderer/hooks/system/useExtI18n.ts`                       | Extension i18n                                                                  |
| `packages/desktop/src/renderer/hooks/system/useExtensionSettingsTabs.ts`         | Extension settings tabs                                                         |
| `packages/desktop/src/renderer/hooks/system/useAutoPreviewOfficeFilesEnabled.ts` | Cờ bật/tắt auto-preview office files                                            |

### `hooks/ui/`

| Hook                                                                 | Mô tả                 |
| -------------------------------------------------------------------- | --------------------- |
| `packages/desktop/src/renderer/hooks/ui/useDebounce.ts`              | Debounce value        |
| `packages/desktop/src/renderer/hooks/ui/useThrottle.ts`              | Throttle callback     |
| `packages/desktop/src/renderer/hooks/ui/useResizableSplit.tsx`       | Resizable split panel |
| `packages/desktop/src/renderer/hooks/ui/useColorScheme.ts`           | Light/dark mode       |
| `packages/desktop/src/renderer/hooks/ui/useFontScale.ts`             | Font scale factor     |
| `packages/desktop/src/renderer/hooks/ui/useConversationShortcuts.ts` | Keyboard shortcuts    |
| `packages/desktop/src/renderer/hooks/ui/useTextSelection.ts`         | Text selection state  |
| `packages/desktop/src/renderer/hooks/ui/useLatestRef.ts`             | Latest value ref      |
| `packages/desktop/src/renderer/hooks/ui/useIndexedItemRefs.ts`       | Indexed item refs     |

---

## 15. Renderer: Services & Utils

### Services (`renderer/services/`)

| File                                                            | Mô tả                           |
| --------------------------------------------------------------- | ------------------------------- |
| `i18n/index.ts`                                                 | i18next setup cho renderer      |
| `packages/desktop/src/renderer/services/i18n/i18n-keys.d.ts`    | Type generated cho i18n keys    |
| `i18n/locales/`                                                 | Locale JSON files               |
| `packages/desktop/src/renderer/services/FileService.ts`         | File operations (upload, read)  |
| `packages/desktop/src/renderer/services/PasteService.ts`        | Clipboard paste handling        |
| `packages/desktop/src/renderer/services/SpeechToTextService.ts` | STT service wrapper             |
| `packages/desktop/src/renderer/services/registerPwa.ts`         | PWA service worker registration |

### Utils (`renderer/utils/`)

#### `utils/chat/`

| File                                                               | Mô tả                                        |
| ------------------------------------------------------------------ | -------------------------------------------- |
| `packages/desktop/src/renderer/utils/chat/autoTitle.ts`            | Generate conversation title từ first message |
| `packages/desktop/src/renderer/utils/chat/messageHistory.ts`       | Message history management                   |
| `packages/desktop/src/renderer/utils/chat/latexDelimiters.ts`      | LaTeX delimiter normalization                |
| `packages/desktop/src/renderer/utils/chat/thinkTagFilter.ts`       | Filter `<think>` tags từ AI response         |
| `packages/desktop/src/renderer/utils/chat/conversationExport.ts`   | Export conversation to markdown/text         |
| `packages/desktop/src/renderer/utils/chat/atFileQuery.ts`          | Query files cho @mention                     |
| `packages/desktop/src/renderer/utils/chat/skillSuggestParser.ts`   | Parse skill suggestions                      |
| `timeline.ts`                                                      | Message timeline grouping                    |
| `packages/desktop/src/renderer/utils/chat/chatMinimapEvents.ts`    | Minimap event handling                       |
| `packages/desktop/src/renderer/utils/chat/getLastAssistantText.ts` | Lấy text cuối của assistant                  |

#### `utils/file/`

| File                                                            | Mô tả                                                                 |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| `packages/desktop/src/renderer/utils/file/fileType.ts`          | Detect file type                                                      |
| `packages/desktop/src/renderer/utils/file/fileTypes.ts`         | File type constants                                                   |
| `packages/desktop/src/renderer/utils/file/base64.ts`            | Base64 encode/decode                                                  |
| `packages/desktop/src/renderer/utils/file/download.ts`          | Download file                                                         |
| `packages/desktop/src/renderer/utils/file/diffUtils.ts`         | Diff utilities                                                        |
| `packages/desktop/src/renderer/utils/file/fileSelection.ts`     | File selection helpers                                                |
| `packages/desktop/src/renderer/utils/file/messageFiles.ts`      | Files trong messages                                                  |
| `packages/desktop/src/renderer/utils/file/workspaceFs.ts`       | Workspace file system ops                                             |
| `packages/desktop/src/renderer/utils/file/workspaceMentions.ts` | @workspace mentions                                                   |
| `packages/desktop/src/renderer/utils/file/writeBinaryFile.ts`   | Ghi/đọc file binary qua Main bridge (studio.write-binary/read-binary) |

#### `utils/model/`

| File                                                              | Mô tả                                |
| ----------------------------------------------------------------- | ------------------------------------ |
| `packages/desktop/src/renderer/utils/model/agentTypes.ts`         | Agent type detection + SWR key       |
| `agentModes.ts`                                                   | Agent mode definitions               |
| `packages/desktop/src/renderer/utils/model/agentLogo.ts`          | Agent logo mapping                   |
| `modelCapabilities.ts`                                            | Model capability flags               |
| `packages/desktop/src/renderer/utils/model/modelContextLimits.ts` | Context window limits                |
| `packages/desktop/src/renderer/utils/model/modelPlatforms.ts`     | Platform definitions (30+ platforms) |
| `packages/desktop/src/renderer/utils/model/errorDetection.ts`     | Detect error types từ AI response    |
| `presetAssistantResources.ts`                                     | Preset assistant metadata            |

#### `utils/theme/`

| File                                                              | Mô tả                    |
| ----------------------------------------------------------------- | ------------------------ |
| `packages/desktop/src/renderer/utils/theme/customCssProcessor.ts` | Process user custom CSS  |
| `packages/desktop/src/renderer/utils/theme/themeCssSync.ts`       | Sync theme CSS variables |

#### `utils/ui/`

| File                                                       | Mô tả                     |
| ---------------------------------------------------------- | ------------------------- |
| `packages/desktop/src/renderer/utils/ui/HOC.tsx`           | Higher-order components   |
| `packages/desktop/src/renderer/utils/ui/ModalHOC.tsx`      | Modal HOC                 |
| `packages/desktop/src/renderer/utils/ui/createContext.tsx` | Type-safe context creator |
| `packages/desktop/src/renderer/utils/ui/clipboard.ts`      | Clipboard operations      |
| `packages/desktop/src/renderer/utils/ui/focus.ts`          | Focus management          |
| `packages/desktop/src/renderer/utils/ui/siderTooltip.ts`   | Sidebar tooltip helpers   |
| `packages/desktop/src/renderer/utils/ui/runtimePatches.ts` | Runtime polyfills         |

#### `utils/devtools/` & `utils/workspace/`

| File                                                                | Mô tả                                    |
| ------------------------------------------------------------------- | ---------------------------------------- |
| `packages/desktop/src/renderer/utils/devtools/devConsoleStore.ts`   | Store cho in-app dev console overlay     |
| `workspace/workspace.ts`                                            | Helper workspace (resolve/validate path) |
| `packages/desktop/src/renderer/utils/workspace/workspaceEvents.ts`  | Event bus thay đổi workspace             |
| `packages/desktop/src/renderer/utils/workspace/workspaceHistory.ts` | Lịch sử workspace gần đây                |

#### `utils/` (file gốc)

| File                                                  | Mô tả                                                        |
| ----------------------------------------------------- | ------------------------------------------------------------ |
| `packages/desktop/src/renderer/utils/common.ts`       | Tiện ích chung                                               |
| `packages/desktop/src/renderer/utils/emitter.ts`      | Event emitter dùng chung renderer                            |
| `packages/desktop/src/renderer/utils/platform.ts`     | Phát hiện nền tảng + `openInAppBrowserTab`/`openExternalUrl` |
| `packages/desktop/src/renderer/utils/previewError.ts` | Chuẩn hóa lỗi preview                                        |

---

## 16. i18n (Đa ngôn ngữ)

### Ngôn ngữ hỗ trợ

| Code    | Ngôn ngữ                       |
| ------- | ------------------------------ |
| `zh-CN` | Tiếng Trung giản thể           |
| `en-US` | Tiếng Anh (reference language) |
| `ja-JP` | Tiếng Nhật                     |
| `zh-TW` | Tiếng Trung phồn thể           |
| `ko-KR` | Tiếng Hàn                      |
| `tr-TR` | Tiếng Thổ Nhĩ Kỳ               |
| `ru-RU` | Tiếng Nga                      |
| `uk-UA` | Tiếng Ukraine                  |
| `vi-VN` | Tiếng Việt                     |

> **Tổng cộng 9 ngôn ngữ.** Tiếng Việt (`vi-VN`) đã được thêm (Yêu cầu 4 của Tomni Agentic spec) — đã có
> thư mục locale `locales/vi-VN/` và nằm trong `supportedLanguages` của `packages/desktop/src/common/config/i18n-config.json`.

### Modules i18n

`common`, `agentMode`, `update`, `login`, `fileSelection`, `preview`, `conversation`,
`settings`, `messages`, `mcp`, `acp`, `codex`, `tools`, `google`, `cron`, `starOffice`,
`guid`, `agent`, `team`, `pet`, `resource`, `company`, `browser`, `editor`, `testing`,
`monitor`, `studio`, `workspace`, `quickActive`, `manager`, `automation`, `ide`, `makeVideo`

> 33 module (xem `packages/desktop/src/common/config/i18n-config.json`). Các module Tomni Agentic/Manager: `resource`, `company`, `browser`,
> `editor`, `testing`, `monitor`, `studio`, `workspace`, `quickActive`, `manager`, `automation`, `ide`,
> `makeVideo` — tất cả có đủ key trên cả 9 ngôn ngữ (gồm `vi-VN`).

### Cấu trúc files

```
renderer/services/i18n/
├── index.ts              ← i18next init
├── i18n-keys.d.ts        ← Generated TypeScript types cho keys
├── locales/              ← Locale JSON files (per language per module)
└── README.md
```

### Workflow thêm i18n key

```bash
# 1. Thêm key vào locales/en-US/*.json và locales/zh-CN/*.json
# 2. Regenerate types
bun run i18n:types

# 3. Validate
node scripts/check-i18n.js

# 4. Dùng trong component
const { t } = useTranslation();
t('module.key.subkey')
```

### Quy tắc

- **KHÔNG bao giờ hardcode string** trong UI — luôn dùng `t('key')`
- Key format: `module.feature.action` (dot-separated, lowercase)
- Fallback language: `en-US`
- Arco Design locale: map từ i18n language code → Arco locale object

---

## 17. Theming & CSS

### Hệ thống màu sắc

Màu sắc dùng **semantic tokens** định nghĩa trong `uno.config.ts`:

```
text-t-primary      ← Text chính
text-t-secondary    ← Text phụ
text-t-tertiary     ← Text mờ
bg-base             ← Background chính
bg-bg-1             ← Background layer 1
border-b-base       ← Border chính
```

**KHÔNG dùng hardcoded colors** (`#86909C`, `rgb(0,0,0)`).

### CSS Architecture

| Layer            | Vị trí                                    | Dùng khi                   |
| ---------------- | ----------------------------------------- | -------------------------- |
| UnoCSS utilities | Inline className                          | Styles đơn giản            |
| CSS Modules      | `ComponentName.module.css`                | Styles phức tạp/reusable   |
| Global styles    | `renderer/styles/`                        | Reset, layout base, themes |
| Arco overrides   | Component CSS Module `:global(.arco-xxx)` | Override Arco components   |

### Theme System

```
renderer/styles/themes/
├── base.css                    ← Base CSS variables
├── default-color-scheme.css    ← Default light/dark colors
├── index.css                   ← Import all themes
└── README.md

renderer/assets/themes/         ← Theme preview images
├── default-theme.png
├── hello-kitty.png
├── misaka-mikoto-theme.png
├── obsidian-book-cover.png
├── retro-windows.png
└── y2k-ledger-cover.png
```

### Custom CSS

User có thể inject custom CSS qua Settings → Display → Custom CSS.
Xử lý bởi `packages/desktop/src/renderer/utils/theme/customCssProcessor.ts` và `packages/desktop/src/renderer/utils/theme/themeCssSync.ts`.

---

## 18. Agent & Multi-Agent System

### Conversation Types (Agent Backends)

| Type               | Mô tả               | Backend                                                   |
| ------------------ | ------------------- | --------------------------------------------------------- |
| `acp`              | ACP protocol agents | Claude Code, Codex, Qwen Code, Goose, OpenClaw, custom... |
| `aionrs`           | Built-in Aion agent | aioncore (Rust)                                           |
| `codex`            | OpenAI Codex        | Codex CLI                                                 |
| `gemini`           | Gemini native       | Gemini API                                                |
| `openclaw-gateway` | OpenClaw gateway    | OpenClaw                                                  |
| `nanobot`          | Nanobot agent       | Nanobot                                                   |
| `remote`           | Remote agent        | HTTP remote                                               |

### ACP (Agent Communication Protocol)

ACP là protocol của AionUi để giao tiếp với CLI agents.

```
Renderer → aioncore → ACP → CLI agent (Claude Code, Codex...)
                   ↑
              WebSocket stream
```

**Luồng ACP conversation:**

1. Tạo conversation với `type: 'acp'`, `extra.backend: 'claude-code'`
2. aioncore spawn CLI process
3. Gửi message → aioncore → CLI stdin
4. CLI stdout → aioncore → WebSocket `message.stream` → renderer
5. Tool calls → `confirmation.add` event → user confirm → `confirmation.confirm`

### Agent Detection

`packages/desktop/src/renderer/utils/model/agentTypes.ts` — `fetchDetectedAgents()`:

- Gọi `GET /api/agents`
- aioncore tự detect CLI tools đã cài trên hệ thống
- Trả về danh sách `AgentMetadata[]`

**Cơ chế detect (bên trong aioncore):** aioncore giữ một CATALOG tĩnh các agent đã biết; mỗi entry có
`agent_source_info.binary_name`, và backend resolve đúng tên binary đó trên `$PATH` lúc hydrate
(`available: true` nếu tìm thấy). Vì vậy nếu binary cài trên máy có TÊN KHÁC với `binary_name` trong
catalog thì agent sẽ `missing` dù đã cài (vd Kiro: catalog probe `kiro-cli-chat` nhưng bản cài tên
`kiro-cli` → tạo shim `kiro-cli-chat` forward sang `kiro-cli` để fix; không cần sửa Rust).

**Tự kiểm tra:** `aioncore.exe doctor` (subcommand) hydrate registry + probe mọi CLI trên `$PATH` và in
bảng per-agent (`available`/`missing` + đường dẫn đã resolve / lý do). Chạy từ cùng shell mà app khởi
động để xác nhận một backend có detect được không trước khi soi server log. CLI ngoài catalog (chưa có
`binary_name`) có thể thêm thủ công qua **Settings → Local Agents → Add Custom Agent** (Command + args
ACP, có Test Connection) hoặc qua extension `contributes.acpAdapters`.

### Supported Agents (auto-detected)

Built-in Agent, Claude Code, Codex, Qwen Code, Goose AI, OpenClaw, Augment Code,
CodeBuddy, Kimi CLI, OpenCode, Factory Droid, GitHub Copilot, Qoder CLI,
Mistral Vibe, Nanobot, Tomni Agentic (aionrs), Snow CLI, Hermes Agent, Cursor Agent...

### Agent Modes

Mỗi agent hỗ trợ các modes khác nhau:

- **Standard** — confirm từng tool call
- **YOLO** — auto-approve tất cả (không hỏi)
- **Full-Auto** — chạy hoàn toàn tự động

### Assistants

21 built-in assistants, mỗi cái là một markdown file với:

- System prompt / rules
- Skills được inject
- Preset context

Assistants được quản lý qua `GET/POST/PUT/DELETE /api/assistants`.

### Skills System (3 tầng)

| Tầng          | Nguồn                  | Mô tả                                       |
| ------------- | ---------------------- | ------------------------------------------- |
| **Builtin**   | Shipped với app        | `pptx`, `docx`, `pdf`, `xlsx`, `mermaid`... |
| **Custom**    | User tạo               | Trong `skills/` directory                   |
| **Extension** | Third-party extensions | Loaded từ Extension SDK                     |

Skills được inject vào agent context khi bắt đầu conversation.

---

## 19. Team Mode

Team Mode cho phép nhiều AI agents làm việc cùng nhau theo cấu trúc Leader-Teammate.

### Kiến trúc

```
User → Leader Agent (Claude Code / Codex / Gemini / Tomni Agentic)
         ↓ chia task
    ┌────┴────┐
Teammate 1  Teammate 2  Teammate N
(ACP/Gemini) (ACP)      (Aionrs)
    ↓           ↓           ↓
  Mailbox ← → Mailbox ← → Mailbox
         ↓
    Team Tasks Board
```

### Data Model

**Team** (`teams` table):

- `lead_agent_id` — ID của Leader agent
- `agents` — JSON array các Teammate agents
- `workspace` — Thư mục làm việc chung
- `workspace_mode: 'shared'` — Tất cả agents dùng chung workspace

**Mailbox** (`mailbox` table):

- Async message passing giữa agents
- `to_agent_id`, `from_agent_id`
- `read` flag

**Team Tasks** (`team_tasks` table):

- Shared task board
- `blocked_by`, `blocks` — dependency graph
- `status: pending/in_progress/done/failed`

### Team MCP Server

aioncore expose một **Team MCP Server** cho Leader agent:

- Leader dùng MCP tools để giao task cho Teammates
- Teammates nhận task qua mailbox
- Kết quả được aggregate bởi Leader

### UI

- `packages/desktop/src/renderer/pages/team/TeamPage.tsx` — Team dashboard
- Sidebar badge hiển thị pending confirmations
- Mỗi agent có permission dialog riêng

---

## 20. MCP (Model Context Protocol)

MCP cho phép agents dùng external tools.

### MCP Server Types

| Transport         | Mô tả                                       |
| ----------------- | ------------------------------------------- |
| `stdio`           | Spawn process, communicate via stdin/stdout |
| `sse`             | Server-Sent Events (HTTP)                   |
| `streamable-http` | HTTP streaming                              |

### MCP Management

```
Settings → Capabilities → Tools tab
  → Add MCP server (name, transport, config JSON)
  → Test connection
  → Enable/disable per server
  → OAuth authentication (nếu cần)
```

### MCP per Conversation

Khi tạo conversation, user chọn MCP servers muốn enable.
Snapshot được lưu vào `extra.mcp_server_ids` và `extra.mcp_servers`.

### Built-in MCP Servers

`process/resources/builtinMcp/` chứa các MCP server tích hợp sẵn (chạy in-process), không cần cấu hình:

| File                                                                        | Mô tả                                           |
| --------------------------------------------------------------------------- | ----------------------------------------------- |
| `packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts`       | Image generation                                |
| `packages/desktop/src/process/resources/builtinMcp/browserControlServer.ts` | Điều khiển embedded browser (Yêu cầu 1)         |
| `packages/desktop/src/process/resources/builtinMcp/companyServer.ts`        | Tools cho mô hình công ty tác nhân (Yêu cầu 3)  |
| `packages/desktop/src/process/resources/builtinMcp/resourceServer.ts`       | Tools truy vấn/điều phối tài nguyên (Yêu cầu 5) |
| `packages/desktop/src/process/resources/builtinMcp/testingServer.ts`        | Tools kiểm thử đa nền tảng (Yêu cầu 2b)         |
| `packages/desktop/src/process/resources/builtinMcp/toolSelectorServer.ts`   | Tự chọn skill/tool (Yêu cầu 7)                  |
| `packages/desktop/src/process/resources/builtinMcp/managerServer.ts`        | Tasks/Note/Schedule cá nhân (stdio)             |
| `packages/desktop/src/process/resources/builtinMcp/cronServer.ts`           | Quản lý Scheduled Tasks (cron) — 7 tools        |
| `constants.ts`                                                              | Hằng số chung                                   |

> Ngoài ra Testing MCP còn được host qua `packages/desktop/src/process/testing/testingMcpHost.ts` trên loopback
> `127.0.0.1:<ephemeral>/sse` và đăng ký vào catalog bằng `packages/desktop/src/process/testing/registerTestingMcp.ts` (xem mục 29, Yêu cầu 2b).
> Browser-Control và **Cron** cũng dùng in-process SSE host tương tự (`packages/desktop/src/process/browser/browserControlMcpHost.ts`,
> `packages/desktop/src/process/cron/cronMcpHost.ts`) vì cần state/HTTP backend sống của Main process (xem mục 22).

### MCP Unified Management

Cấu hình MCP một lần → tự động sync đến tất cả agents.

---

## 21. Remote Access & Channels

### WebUI Mode

AionUi có thể chạy như web server (không cần Electron):

```bash
bun run webui              # LAN access
bun run webui:remote       # Remote access
bun run webui:prod         # Production mode
```

Hoặc dùng CLI:

```bash
aionui-web [--remote] [--port 25809]
```

**Cơ chế:**

- `web-host` package khởi động aioncore + static HTTP server
- Static server serve renderer build + proxy `/api/*` và `/ws` → aioncore
- Authentication: JWT (password hoặc QR code)

### Chat Channels

Cấu hình tại Settings → WebUI Settings → Channel:

| Channel           | SDK                     | Mô tả             |
| ----------------- | ----------------------- | ----------------- |
| **Telegram**      | grammy                  | Bot token         |
| **Lark (Feishu)** | @larksuiteoapi/node-sdk | Enterprise bot    |
| **DingTalk**      | dingtalk-stream         | AI Card streaming |
| **WeChat**        | Custom                  | Personal WeChat   |
| **WeCom**         | @wecom/aibot-node-sdk   | Enterprise WeChat |
| **Discord**       | (coming soon)           |                   |
| **Slack**         | (coming soon)           |                   |

Channel logos: `renderer/assets/channel-logos/`

### Remote Agent

Kết nối đến remote AionUi instance:

```
Settings → Agent → Remote Agents
  → URL + auth token
  → Test connection
  → Handshake
```

---

## 22. Scheduled Tasks (Cron)

### Scheduling Modes

| Mode            | Ví dụ            | Mô tả                            |
| --------------- | ---------------- | -------------------------------- |
| Cron expression | `0 9 * * 1`      | Standard 5-field cron + timezone |
| Fixed interval  | Every 30 minutes | Chạy định kỳ                     |
| One-time        | 2026-06-01 09:00 | Chạy một lần rồi disable         |

### Execution Modes

| Mode                              | Mô tả                                    |
| --------------------------------- | ---------------------------------------- |
| Continue in existing conversation | Append vào conversation cũ (giữ context) |
| Create new conversation each time | Tạo conversation mới mỗi lần trigger     |

### Features

- **Conversation-bound** — mỗi cron job gắn với một conversation
- **Keep-awake** — ngăn system sleep khi có task active
- **Missed trigger detection** — phát hiện trigger bị bỏ lỡ sau wake
- **Per-task config** — model, workspace, reasoning effort riêng

### Two planes (UI + Agent)

Giống mọi năng lực Tomni Agentic khác, Scheduled Tasks phơi **hai mặt phẳng**, cùng dùng aioncore
`/api/cron/*` làm nguồn chân lý duy nhất (job agent tạo hiện luôn trên trang Scheduled Tasks và ngược lại):

- **UI plane** — `renderer/pages/cron/` + `ipcBridge.cron.*` (REST wrapper).
- **Agent plane** — built-in **Cron MCP server** (`packages/desktop/src/process/resources/builtinMcp/cronServer.ts`, tools
  `cron_list_tasks`/`cron_get_task`/`cron_create_task`/`cron_update_task`/`cron_set_enabled`/`cron_run_now`/`cron_delete_task`).
  Vì cron là HTTP-backed trong aioncore (cần `globalThis.__backendPort`), nó chạy **in-process SSE host**
  (`packages/desktop/src/process/cron/cronMcpHost.ts`, mirror Testing/Browser-Control) — KHÔNG phải stdio standalone, nên không
  có esbuild entry. Đăng ký vào MCP catalog dạng `sse`, `enabled:false` (opt-in per-conversation qua MCP
  picker / "Super"), idempotent refresh URL mỗi boot qua `packages/desktop/src/process/cron/registerCronMcp.ts` (gọi trong
  `runBackendMigrations` bước `ensureCronMcpRegistered`).

### Code

```
pages/cron/                 ← UI plane
├── ScheduledTasksPage/     ← UI
├── cronUtils.ts            ← Parse/validate cron expressions
├── useCronJobs.ts          ← SWR hook
└── repairCronJobTimeZone.ts ← One-shot timezone fix

process/cron/               ← Agent plane wiring
├── cronMcpHost.ts          ← In-process SSE host (loopback)
├── cronWiring.ts           ← Build deps từ cron.* bridge + start host
└── registerCronMcp.ts      ← Đăng ký/refresh entry trong MCP catalog
resources/builtinMcp/cronServer.ts ← MCP server factory (7 tools)
```

---

## 23. Preview Panel

Preview panel hiển thị files được AI tạo ra, không cần rời app.

### Supported Formats

| Category  | Formats                                                                                 |
| --------- | --------------------------------------------------------------------------------------- |
| Documents | PDF, Word (.doc/.docx/.odt), Excel (.xls/.xlsx/.ods/.csv), PowerPoint (.ppt/.pptx/.odp) |
| Code      | JS, TS, Python, Java, Go, Rust, C/C++, CSS, JSON, XML, YAML, Shell, 30+ languages       |
| Markup    | Markdown (.md/.markdown), HTML (.html/.htm)                                             |
| Images    | PNG, JPG, GIF, SVG, WebP, BMP, ICO, TIFF, AVIF                                          |
| Other     | Diff files (.diff/.patch)                                                               |

### Features

- **Real-time tracking** — tự động cập nhật khi file thay đổi
- **Multi-tab** — mở nhiều files cùng lúc
- **Version history** — xem và restore lịch sử (Git-based, dùng `fileSnapshot` API)
- **Live editing** — sửa trực tiếp Markdown, code, HTML

### Code

```
pages/conversation/Preview/
├── components/             ← Renderers cho từng format
├── context/PreviewContext.tsx ← Preview state (tabs, active file)
├── hooks/                  ← usePreviewFile, useFileHistory...
├── types.ts
└── README.en.md / README.cn.md
```

---

## 24. Desktop Pet

Nhân vật ảo tương tác với trạng thái AI.

### Pet Windows

| Window         | File                                                 | Mô tả                     |
| -------------- | ---------------------------------------------------- | ------------------------- |
| Main pet       | `packages/desktop/src/renderer/pet/pet.html`         | Nhân vật chính            |
| Confirm bubble | `packages/desktop/src/renderer/pet/pet-confirm.html` | Tool confirmation qua pet |
| Hit animation  | `packages/desktop/src/renderer/pet/pet-hit.html`     | Animation khi click       |

### Pet State Machine

States: `idle` → `active` → `thinking` → `working` → `done` → `idle`

### Pet Config

```
Settings → Pet
  - Enable/disable
  - Size (200/280/360px)
  - Do Not Disturb mode
  - Route confirmations to pet bubble
```

---

## 25. Quy ước Code

### Naming Conventions

| Loại             | Convention                        | Ví dụ                                                                                                               |
| ---------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| React components | PascalCase                        | `Button.tsx`, `SettingsModal.tsx`                                                                                   |
| Hooks            | camelCase + `use` prefix          | `packages/desktop/src/renderer/hooks/system/useTheme.ts`, `packages/desktop/src/renderer/pages/cron/useCronJobs.ts` |
| Utilities        | camelCase                         | `formatDate.ts`, `packages/desktop/src/renderer/pages/cron/cronUtils.ts`                                            |
| Constants files  | camelCase                         | `constants.ts`                                                                                                      |
| Constants values | UPPER_SNAKE_CASE                  | `MAX_RETRY_COUNT`                                                                                                   |
| Type files       | camelCase                         | `types.ts`                                                                                                          |
| Style files      | kebab-case hoặc `Name.module.css` | `packages/desktop/src/renderer/pages/conversation/components/ChatLayout/chat-layout.css`                            |
| Unused params    | `_` prefix                        | `_event`, `_id`                                                                                                     |

### Directory Naming

| Scope                          | Convention                                       |
| ------------------------------ | ------------------------------------------------ |
| Renderer component/module dirs | PascalCase (`SettingsModal/`, `GroupedHistory/`) |
| Categorical dirs (everywhere)  | lowercase (`components/`, `hooks/`, `utils/`)    |
| Platform dirs (everywhere)     | lowercase (`acp/`, `codex/`, `gemini/`)          |
| Non-renderer dirs              | lowercase (`services/`, `bridge/`)               |

### Directory Size Limit

**Tối đa 10 direct children** (files + subdirs) trong một directory.
Khi gần đến giới hạn → split theo responsibility.

### TypeScript Rules

- **Strict mode** — không `any`, không implicit returns
- Path aliases: `@/*` (common), `@process/*` (main process), `@renderer/*` (renderer)
- Prefer `type` over `interface` (per oxlint config)
- English cho code comments; JSDoc cho public functions

### UI Rules

- **Components:** `@arco-design/web-react` — KHÔNG dùng raw `<button>`, `<input>`, `<select>`
- **Icons:** `@icon-park/react` — KHÔNG dùng icon từ nguồn khác
- **Colors:** semantic tokens từ `uno.config.ts` — KHÔNG hardcode màu
- **CSS:** UnoCSS utilities trước, CSS Modules cho complex styles

### Process Boundary Rules (QUAN TRỌNG)

```
Main Process (process/)     → Node.js APIs OK, DOM APIs FORBIDDEN
Renderer Process (renderer/) → DOM/React OK, Node.js APIs FORBIDDEN
Worker Process              → Node.js APIs OK, DOM/Electron FORBIDDEN
Preload (preload/)          → contextBridge + ipcRenderer ONLY
```

**Vi phạm rule này gây runtime crash.**

Cross-process communication:

- Main ↔ Renderer: IPC qua `preload/main.ts` + `process/bridge/*.ts`
- Main ↔ Worker: fork protocol qua `WorkerProtocol.ts`

### Service Design Rules

```typescript
// ❌ Hard to test — direct IO import
import { db } from '@process/database';
function getConversation(id: string) {
  return db.query('SELECT * FROM conversations WHERE id = ?', id);
}

// ✅ Easy to test — dependency injection
function getConversation(repo: IConversationRepository, id: string) {
  return repo.findById(id);
}
```

---

## 26. Workflow Phát triển

### Setup

```bash
git clone https://github.com/VNDT1625/OmniAgent.git
cd AionUi
bun install
bun start          # Electron dev mode
```

### Trong khi dev

```bash
bun run lint:fix   # Auto-fix lint (oxlint)
bun run format     # Auto-format (oxfmt)
bunx tsc --noEmit  # Type check

# Nếu thay đổi renderer/, locales/, hoặc i18n config:
bun run i18n:types
node scripts/check-i18n.js
```

### Trước khi push

```bash
just push                          # lint → format-check → typecheck → test → git push
just push -u origin feat/branch    # với extra git push args
```

> `just push` dùng `--quiet` cho lint — chỉ errors mới fail, warnings không fail.

### Commit Format

```
<type>(<scope>): <subject>

Types: feat, fix, refactor, chore, docs, test, style, perf
```

**KHÔNG thêm AI signatures** (Co-Authored-By, Generated with...).

### PR Rules

1. **Atomic PRs** — mỗi PR chỉ một feature hoặc một bug fix
2. **Pass local checks** trước khi push
3. **Không push thẳng lên main/master** — luôn dùng feature branch

### PR Automation Bot Labels

| Label                    | Ý nghĩa          |
| ------------------------ | ---------------- |
| `bot:reviewing`          | Bot đang review  |
| `bot:ci-waiting`         | CI fail, chờ fix |
| `bot:needs-rebase`       | Cần rebase       |
| `bot:needs-human-review` | Cần người review |
| `bot:ready-to-merge`     | Sẵn sàng merge   |

---

## 27. Testing

### Framework: Vitest 4

```bash
bun run test              # Chạy tất cả unit tests
bun run test:watch        # Watch mode
bun run test:coverage     # Coverage report (target ≥ 80%)
bun run test:integration  # Integration tests
bun run test:e2e          # Playwright E2E tests
bun run test:bun          # Bun-specific database tests
```

### Test File Mapping

| Source                                                        | Test                                                |
| ------------------------------------------------------------- | --------------------------------------------------- |
| `process/services/CronService.ts`                             | `tests/unit/cronService.test.ts`                    |
| `renderer/hooks/ui/useAutoScroll.ts`                          | `tests/unit/useAutoScroll.dom.test.ts`              |
| `packages/desktop/src/renderer/utils/chat/latexDelimiters.ts` | `tests/unit/renderer/utils/latexDelimiters.test.ts` |

### Test Structure

```
tests/
├── unit/               ← Unit tests (mirror source structure)
├── integration/        ← Integration tests
├── e2e/                ← Playwright E2E
│   └── cases/
│       └── teams/      ← Team mode E2E tests
├── fixtures/           ← Test fixtures
├── vitest.setup.ts     ← Global test setup
└── vitest.dom.setup.ts ← DOM test setup (@testing-library)
```

### DOM Tests

Files ending in `.dom.test.ts` dùng jsdom environment.
Setup: `tests/vitest.dom.setup.ts` (import @testing-library/jest-dom).

---

## 28. Build & Distribution

### Build Commands

```bash
bun run package          # Build tất cả processes → out/
bun run dist             # Build + package cho current platform
bun run dist:mac         # macOS
bun run dist:win         # Windows
bun run dist:linux       # Linux (.deb)
bun run build-mac        # macOS arm64 + x64
bun run build-win:x64    # Windows x64
bun run build-win:arm64  # Windows ARM64
```

### Build Output

```
out/
├── main/       ← Main process bundle
├── renderer/   ← Renderer bundle (React app)
└── preload/    ← Preload scripts
```

### electron-builder Config

`packages/desktop/electron-builder.yml` — cấu hình packaging:

- App ID, product name
- File associations
- Code signing (macOS)
- Auto-update config
- Platform-specific installers

### electron-vite Config

`packages/desktop/electron.vite.config.ts` — build config:

- Main process: Vite ESM bundle
- Renderer: Vite + React + UnoCSS
- Preload: Vite bundle

### Native Modules

`better-sqlite3` là native module, cần rebuild cho Electron:

```bash
node scripts/rebuildNativeModules.js
```

### aioncore Bundling

`scripts/prepareAioncore.js` — copy aioncore binary vào `resources/bundled-aioncore/`.

---

## 29. Spec đang mở: Tomni Agentic Enhancements

File: `.kiro/specs/aionui-enhancements/requirements.md`

Đây là spec phát triển **Tomni Agentic** — fork của AionUi cho nhu cầu cá nhân.

### Mục tiêu

Biến AionUi thành nền tảng desktop đa tác vụ xử lý 80–90% công việc trên một giao diện.

### 8 Nhóm yêu cầu (theo thứ tự ưu tiên)

| #   | Yêu cầu                                    | Ưu tiên                     | Phụ thuộc            |
| --- | ------------------------------------------ | --------------------------- | -------------------- |
| 5   | Quản lý tài nguyên chống lag               | **NỀN MÓNG — làm sớm nhất** | —                    |
| 4   | Bổ sung tiếng Việt toàn diện               | Cao (dễ, làm song song)     | —                    |
| 1   | Tích hợp trình duyệt + web agent           | Cao                         | Yêu cầu 5            |
| 2a  | Trình soạn đa năng (sửa mọi loại file)     | Cao                         | Yêu cầu 5            |
| 7   | Tác nhân tự chọn kỹ năng/công cụ           | Trung bình                  | Skills system sẵn có |
| 2b  | Kiểm thử đa nền tảng (web/Android/Windows) | Nặng                        | Yêu cầu 5            |
| 3   | Mô hình công ty tác nhân                   | Sau                         | Yêu cầu 7            |
| 6   | Tác nhân giám sát + sửa lỗi                | Sau                         | Yêu cầu 2b           |

### Chi tiết từng yêu cầu

#### Yêu cầu 5 — Resource Manager (NỀN MÓNG)

- Đọc thông số máy khi khởi động (RAM, CPU, GPU)
- 2 chế độ: chi tiết (user tự đặt) + gợi ý (tự cân bằng)
- 3 mức nhanh: Tiết kiệm / Cân bằng / Hiệu năng cao
- Hàng chờ cho tác vụ nặng vượt giới hạn
- Tạm nghỉ components không dùng để nhả RAM
- 3 bậc cân bằng: đánh giá ban đầu → tự dò real-time → AI phân tích sâu
- Mọi tác vụ nặng PHẢI đăng ký qua resource manager này

#### Yêu cầu 4 — Tiếng Việt

- Thêm `vi-VN` vào `packages/desktop/src/common/config/i18n-config.json`
- Dịch tất cả modules: common, agentMode, update, login, conversation, settings...
- Fallback sang `en-US` nếu key chưa có bản dịch

#### Yêu cầu 1 — Browser + Web Agent

- Embedded browser qua `WebContentsView` theo tab (`packages/desktop/src/process/browser/browserViewManager.ts`) — phiên đăng nhập thật, có `setZoom` (fit-to-frame).
- **Web agent CHẠY THẬT**: `packages/desktop/src/process/browser/webAgentRunner.ts` — vòng lặp ReAct, model trả JSON 1-action. Bộ tool: navigate, read_text, click, type, scroll, **screenshot** (vision, leased qua ResourceCoordinator), **go_back/go_forward/reload**, **wait_for**, **press_key**, **remember**, **video_transcript** (passive trên tab hiển thị → fallback active trong tab ẩn), **analyze_audio**, **research**, **summarize** (readability + map-reduce), **deep_research** (đa nguồn, citation), finish. LLM qua `packages/desktop/src/process/browser/providerChat.ts` (provider/model người dùng đã chọn, OpenAI-compatible `/chat/completions`). Mỗi lượt runner chèn observation "Context — the tab is currently on: URL/TITLE" để model không chế URL.
- **Lớp research** (`process/browser/research/`): `packages/desktop/src/process/browser/research/readability.ts` trích nội dung chính (bỏ nav/ad/footer) cho `summarize`; `packages/desktop/src/process/browser/research/summarizer.ts` map-reduce (chunk → map → reduce) bỏ trần 4000 ký tự; `packages/desktop/src/process/browser/research/deepResearch.ts` plan sub-query → search song song (hidden tab) → đọc nhiều nguồn (readability, lease 'agent' mỗi read, concurrency giới hạn) → digest (bỏ IRRELEVANT) → synthesize có citation [n] → 1 vòng reflection. Tất cả DI, wire ở `getBrowserServices`.
- **Live URL/title**: `browserViewManager` lắng nghe `did-navigate`/`did-navigate-in-page`/`page-title-updated` (chỉ tab visible) → emitter `browser.tab-updated` → `useBrowserState` cập nhật thanh URL realtime kể cả SPA (đổi video YouTube). Tab ẩn (research) không phát.
- **Personal agent**: `packages/desktop/src/process/browser/browserMemory.ts` — persona (chỉ dẫn cố định, chèn vào system prompt mỗi lượt) + ghi chú theo site (`browser-agent-memory.json` ở userData). Tool `remember` để agent tự lưu; kênh `browser.get-persona`/`set-persona`; UI sửa persona ở `AgentChatPanel`.
- UI: `renderer/pages/browser/` — thanh URL (duyệt thường) + **khung chat tác nhân** (`AgentChatPanel`, dock trái/phải đổi được, stream bước agent, nút Persona), toolbar zoom/fullscreen/toggle-chat (`BrowserToolbar`).
- IPC (UI plane + Agent plane chung 1 bridge): `browser.*` gồm open/navigate/setBounds/**setZoom**/show/hide/listTabs/destroyTab/getAgentMode/setAgentMode/**runAgent**/**cancelAgent**/**getPersona**/**setPersona** + emitter **agentEvent** (envelope `{event}`) + emitter **tabUpdated** (URL/title realtime, kể cả SPA). Đăng ký ở `initAllBridges()` (`process/bridge/index.ts`).
- **Video understanding**: tool `video_transcript` bóc caption YouTube (timedtext json3) / HTML5 `<video>` cues / panel transcript ngay trong page → agent tóm tắt (không tải video, không ffmpeg). Phụ đề real-time STT + lồng tiếng cần worker Whisper/ffmpeg/TTS (mediaPipeline đã có orchestration; worker là task tương lai).

#### Yêu cầu 2a — Universal Editor

- Monaco editor cho text/code (tất cả ngôn ngữ)
- Sửa Word (.docx) — nội dung + định dạng cơ bản
- Sửa Excel (.xlsx) — dạng bảng
- Sửa PPT (.pptx) — nội dung slide
- PDF: xem + ghi chú + điền form + convert ↔ Word
- Ảnh: xem + cắt/xoay/resize
- Video/audio: phát + bóc lời + tóm tắt (online hoặc local model)

**Lối vào UI (wiring):** Universal Editor được mở từ **Studio app** (`/studio`, `renderer/pages/studio/`) — một dashboard kiểu WPS: rail trái (Open file, Make Video, Recent/Starred), cột chính liệt kê file (icon theo loại), mở file → `StudioEditorView` bọc `UniversalEditor`. Recent/Starred lưu `localStorage` (`packages/desktop/src/renderer/pages/studio/studioStorage.ts`); mở file qua `dialog.showOpen`, đọc/ghi qua `useEditorFile` (HTTP fs bridge). Phân loại file→adapter dùng chung `editorRegistry`. Sidebar entry: `packages/desktop/src/renderer/components/layout/Sider/SiderNav/SiderStudioEntry.tsx`.

**Panel AI trong editor:** `StudioEditorView` chia đôi — `DocAssistantPanel` (trái) + `UniversalEditor` (phải) **dùng chung 1 buffer** qua hook `packages/desktop/src/renderer/pages/editor/hooks/useUniversalEditor.ts` (truyền `controller` vào `UniversalEditor`). Panel gọi model qua Main-process bridge `packages/desktop/src/process/studio/studioChatBridge.ts` (kênh `studio.chat`, provider-backed `/chat/completions` — renderer không gọi provider trực tiếp được vì CORS), client `packages/desktop/src/renderer/pages/studio/studioChatClient.ts` + hook `useDocAssistant.ts`. Reply chứa code block → nút "Apply to document" ghi vào buffer editor. Panel đóng được (nút ✕ + toggle trên header).

**IDE hợp nhất (Files/Map/Ask/Wiki) + Create file:** Dashboard có nút **IDE** mở `packages/desktop/src/renderer/pages/studio/ide/IdeWorkspace.tsx`
— một workspace duy nhất, activity-bar trái 4 chế độ dùng CHUNG một folder (`packages/desktop/src/renderer/pages/studio/ide/useIdeWorkspace.ts`):
(1) **Files** — cây file Arco `Tree` (`fs.getFilesByDir`) + `UniversalEditor` (editor giữ mounted để AI
edit chạy nền khi đổi tab); (2) **Map** — đồ thị phụ thuộc `RepoGraphView` (kênh `ide.scan-repo`), chọn
node → focus Ask; (3) **Ask** — `ExplainPanel` hỏi kiến trúc (kênh `ide.explain`), grounding theo file
đang chọn hoặc hub; (4) **Wiki** — tài liệu kiểu DeepWiki, nay **production-grade & bền vững** (xem callout
2026-06-09 "Wiki production-grade"): mở tab tự `ide.wiki-load` đọc wiki đã lưu; "Generate/Regenerate" chạy
`ide.wiki-build` (verify doc với code → tự sửa doc → viết + tự đánh giá/cải thiện từng mục → lưu đĩa),
stream phase qua `ide.wiki-progress`; nav mục + báo cáo "documentation check" + điểm chất lượng + "evidence".
**Persist phiên IDE (folder + tabs):** `useIdeWorkspace` lưu `{rootPath, openFiles, activeFile}` vào
`localStorage` key `studio.ide.session`; khi vào lại IDE nó **khôi phục folder + các tab đang mở** (cờ
`restoring` hiện spinner thay vì màn hình "mở folder") thay vì bắt chọn lại từ đầu. Tab có thanh tab
(`EditorTabs`) đóng được từng cái. **Mở folder khác:** nút header "Open another folder" → nếu có file
chưa lưu (`hasUnsaved`, đếm qua `markDirty` mà `UniversalEditor` báo lên bằng prop `onDirtyChange`) thì
`Modal.confirm` cảnh báo sẽ mất thay đổi trước khi `pickFolder` reset tabs/dirty và mở folder mới. i18n
`ide.workspace.*`. Test: `tests/unit/ide/useIdeWorkspace.dom.test.ts`.
**Create file (có agent tạo nội dung):** Dashboard có nút **Tạo tệp** mở `packages/desktop/src/renderer/pages/studio/components/CreateFileModal.tsx`
với 2 chế độ (`packages/desktop/src/renderer/pages/studio/hooks/useFileCreator.ts`): (1) **Empty** — nhập tên → `dialog.showOpen(openDirectory)` →
`fs.writeFile` rỗng → mở editor (hành vi cũ); (2) **Generate (AI)** — chọn model (`useModelProviderList`),
nhập mô tả + đính kèm file tham chiếu tùy ý (`dialog.showOpen` multiSelections), agent đọc reference theo
loại (docx/xlsx/pptx/text qua các client sẵn có), gọi `studio.chat` sinh nội dung, rồi ghi đúng dạng theo
loại file đích (`.docx`→`writeDocxText`, `.xlsx`→`writeXlsxCsv` CSV, còn lại→`fs.writeFile`) trước khi mở
editor. `kindSupportsGeneration()` chỉ bật generate cho text-code/raw-text/docx/spreadsheet; loại binary
(slide/pdf/image/media) tự về empty. i18n `studio.create.*`. Test: `tests/unit/studio/CreateFileModal.dom.test.tsx`.

**Ghi file binary (quan trọng):** `/api/fs/write` của aioncore ghi `data` dưới dạng text thuần (KHÔNG decode base64) → lưu file binary sẽ hỏng. Vì vậy có Main-process bridge `packages/desktop/src/process/studio/studioFsBridge.ts` (kênh `studio.write-binary`) ghi raw bytes bằng Node fs; renderer dùng `packages/desktop/src/renderer/utils/file/writeBinaryFile.ts`. `useEditorFile.save` ở mode `binary` đi qua đường này (đúng cho docx + ảnh).

**docx editable + xem giữ định dạng:** `.docx` có 2 chế độ — **Formatted** (mặc định, tái dùng `Preview/.../viewers/OfficeDocViewer` = officecli-watch + webview, render đẹp như Word) + **Edit** (text qua Main bridge `packages/desktop/src/process/studio/studioDocxBridge.ts` kênh `studio.docx-read`/`docx-write`, Node `mammoth` đọc / `docx` ghi; `.doc` cũ đọc bằng `word-extractor`). Client `packages/desktop/src/renderer/pages/editor/adapters/studioDocxClient.ts`. Sửa nội dung chữ; lưu dựng .docx sạch.

**xlsx / pptx:** Formatted tái dùng `ExcelViewer`/`PptViewer` (officecli-watch). SpreadsheetAdapter có thêm chế độ **Edit** = grid CSV (đọc/ghi qua `packages/desktop/src/process/studio/studioOfficeBridge.ts` kênh `studio.xlsx-read`/`xlsx-write`). SlideAdapter có thêm chế độ **Text** (trích text qua `studio.pptx-read`, yauzl + `<a:t>`). Client `packages/desktop/src/renderer/pages/editor/adapters/studioOfficeClient.ts`.

> **Nguyên tắc xem giữ định dạng:** TÁI DÙNG `OfficeWatchViewer` (officecli) — cùng cơ chế Preview panel dùng cho pptx/pdf — thay vì parser ZIP ở renderer (docx-preview/JSZip không ổn định với file thật). Chế độ Edit/grid mới đi qua Main bridge để sửa-lưu.

**Chỉnh sửa WYSIWYG thật (ONLYOFFICE, on-demand):** cả 3 adapter (`DocxAdapter`/`SpreadsheetAdapter`/`SlideAdapter`) có chế độ thứ ba **"Office"** = trình soạn thảo Office đầy đủ qua ONLYOFFICE Document Server, chỉ khởi động khi người dùng cần. Renderer `packages/desktop/src/renderer/pages/editor/adapters/OnlyOfficeEditor.tsx` gọi `ensureDocumentServer` (resolving) → `startOfficeEdit` (connecting) → nạp `<url>/web-apps/apps/api/documents/api.js` và mount `DocsAPI.DocEditor` (autosave/forcesave). Settings URL trong `packages/desktop/src/renderer/pages/editor/adapters/OnlyOfficeSettingsModal.tsx` (localStorage `studio.onlyofficeUrl`), client `packages/desktop/src/renderer/pages/editor/adapters/onlyOfficeClient.ts`.

- Main: `packages/desktop/src/process/studio/onlyOfficeServer.ts` = integration host HTTP cục bộ (serve `/download/:token`, nhận `/callback/:token` lưu file đã sửa, idle-shutdown 5 phút). `packages/desktop/src/process/studio/documentServerManager.ts` = `ensureDocumentServer()`: ưu tiên URL cấu hình nếu `/healthcheck` OK, nếu không thì tự `docker run/start` container `aionui-onlyoffice` (`onlyoffice/documentserver:latest`, cổng 8080), chờ healthcheck; lỗi typed `docker-missing`/`docker-stopped`/`start-failed`/`timeout`. `packages/desktop/src/process/studio/onlyOfficeBridge.ts` 3 kênh: `studio.office-edit-start`/`studio.office-edit-stop`/`studio.office-ensure-server`.
- **License:** ONLYOFFICE là **AGPL-3.0** → KHÔNG nhúng/merge code; chạy như server riêng (Docker), app chỉ tích hợp qua HTTP. Document Server (~GB) KHÔNG bundle. Khi Docker thiếu/chưa chạy → hiện hint, người dùng có thể nhập URL thủ công; vẫn còn 2 đường lui Formatted + Edit/Text.

#### Yêu cầu 7 — Auto Tool Selection

- Mỗi skill/tool có mô tả ngắn
- Bậc 1: lọc theo từ khóa
- Bậc 2: lọc theo ngữ nghĩa (vector search)
- Bậc 3: tự tạo skill mới nếu không có (giai đoạn sau)
- Vòng chọn–thử–chọn lại

#### Tính năng bổ sung — "Super" (agent điều khiển trình duyệt sống) + Workspace surfaces

Header mỗi conversation có toggle **"Super"** (`packages/desktop/src/renderer/pages/conversation/components/ConversationSurfaces.tsx`). Bật Super = đính built-in
MCP `aionui-browser-control` vào `conversation.extra.session_mcp_servers` → agent được quyền dùng bộ
tool Browser-Control để tự mở/điều khiển trình duyệt nhúng sống khi cần. Tắt = gỡ tool, chat bình thường.

- **Toggle phản ánh trạng thái THẬT:** `packages/desktop/src/renderer/pages/conversation/hooks/useSuperMode.ts` đọc `ipcBridge.conversation.get` để biết
  `session_mcp_servers` có `aionui-browser-control` chưa (KHÔNG chỉ dựa localStorage) → chat tạo với
  Super-on (qua GuidPage) vào lại vẫn hiện ON. localStorage chỉ là cache optimistic.
- **Xem trong chat (panel dock, NHIỀU FRAME — không phải route/tab app):** nút "Watch" mở
  `packages/desktop/src/renderer/pages/conversation/components/superWatch/LiveBrowserWatch.tsx` — panel dock bên phải (co giãn, **tự mở** khi agent mở tab đầu). MỖI tab agent
  mở = MỘT `packages/desktop/src/renderer/pages/conversation/components/superWatch/LiveBrowserFrame.tsx` riêng, render CÙNG LÚC dạng grid (1 cột nếu 1 tab, 2 cột nếu ≥2 → "mở
  Facebook VÀ YouTube" = 2 frame cạnh nhau). Mỗi frame đo rect → `browser.set-bounds` + `setVisible(id,
true)` cho tab của nó. Hook `hooks/useLiveBrowserTabs.ts` (list + poll 1.5s + patch `browser.tab-updated`).
  Read-only WATCH; đóng → `hideAll`.
- **Đa-frame, KHÔNG độc quyền:** `browserViewManager` thêm `setVisible(id,visible)` (KHÁC `show` độc
  quyền vốn ẩn mọi tab khác) + kênh `browser.set-visible` → nhiều `WebContentsView` paint đồng thời.
- **Đa-frame thay cho sub-agent:** agent CLI có primitive `Spawn` riêng nhưng KHÔNG nối tới AionUi và
  sub-agent không kế thừa session MCP (ở aioncore/Rust — **không có source trong repo**, chỉ là binary
  tải sẵn → không sửa được ở đây). Để "2 trình duyệt cùng lúc", agent tự gọi `browser_open` nhiều lần
  - `browser_list_tabs` (hướng dẫn trong `packages/desktop/src/process/resources/builtinMcp/browserControlServer.ts`) → mỗi tab = 1 frame trong grid.
- **EDITOR frame (Super = super-agent đa năng):** ngoài browser, Super còn cấp tool `editor_*`
  (`editor_open`/`editor_read`/`editor_write`/`editor_close`/`editor_list`) gắn CHUNG vào MCP
  browser-control. `packages/desktop/src/process/editor/editorFrameStore.ts` (registry frame Main-process, version bump);
  `packages/desktop/src/process/editor/editorControlBridge.ts` (kênh `editor.list-frames`/`editor.close-frame`, đăng ký ở `initAllBridges()`).
  Renderer: `packages/desktop/src/renderer/pages/conversation/components/superWatch/LiveEditorFrame.tsx` render `UniversalEditor` (read-only, reload theo version);
  `useLiveBrowserTabs` trả `tabs`+`editors`+`total`; grid render browser frame + editor frame cạnh nhau.
  File agent sửa = file Studio mở (cùng fs `/api/fs/read|write`). Agent dùng app end-to-end qua frame
  HOẶC qua lệnh (gọi tool nhận kết quả).
- **Standing rules khi bật Super:** `packages/desktop/src/renderer/pages/conversation/hooks/superGuidance.ts` (`SUPER_BROWSER_RULES` +
  `withSuperBrowserRules`, marker "Super capabilities (Super is ON)") được bơm vào `extra.preset_rules`
  lúc bật Super (`useSuperMode.toggle`) và lúc tạo chat mới có Super (`useGuidSend`). Liệt kê cả
  `browser_*` lẫn `editor_*`, research-first (`browser_research` ẩn), mở nhiều frame thay vì spawn/shell.
  Lý do: nếu không, agent aionrs hay "mở trình duyệt" bằng cách **shell-out lệnh OS `start`/`open` +
  spawn sub-agent** → trên Windows lỗi "Windows cannot find '\\'" và sub-agent không có tool.

##### Workspace (multi-sub-agent live frames) — dùng lại được, KHÔNG tự mở khi bật Super

`renderer/pages/workspace/` (`packages/desktop/src/renderer/pages/workspace/WorkspaceSurfaces.tsx` + orchestrator) chạy **nhiều sub-agent song song
trong một chat**, mỗi cái một "live frame" riêng. Ví dụ: "vừa search web A vừa edit B" → một browser
surface + một editor surface chạy đồng thời.

> **Không phải route riêng:** KHÔNG có route `/settings/workspace`. `WorkspaceSurfaces` (composer + grid
> live-frame) trước đây nhúng qua `packages/desktop/src/renderer/pages/conversation/components/ConversationSurfaces.tsx`; nay nút Super CHỈ mở popup watch, KHÔNG tự
> mở composer này nữa (tránh "trang ngoài kế hoạch"). Component vẫn còn để tái dùng cho luồng fan-out.

- **Orchestrator:** `packages/desktop/src/process/workspace/workspaceOrchestrator.ts` — chạy N surface song song, mỗi surface
  xin lease `TaskKind:'agent'` qua `ResourceCoordinator` (coordinator quyết parallelism; dư thì `queued`).
  Mỗi surface có `AbortController` riêng → cách ly lỗi; lease luôn release; `cancel(runId)` abort cả run.
- **Surface runners:** `packages/desktop/src/process/workspace/browserSurfaceRunner.ts` (mỗi surface 1 tab riêng, reuse `webAgentRunner` —
  tab-isolated input, dispose destroy tab) và `packages/desktop/src/process/workspace/editorAgentRunner.ts` (đọc file → model trả JSON write/finish
  → ghi qua `/api/fs/write`).
- **Types:** `packages/desktop/src/process/workspace/surfaceTypes.ts` (SurfaceSpec/State/Event, ISurfaceRunner) — import được cả 2 process qua `import type`.
- **Bridge:** `packages/desktop/src/process/workspace/workspaceBridge.ts` — kênh `workspace.run` (long-lived), `workspace.cancel`, emitter
  `workspace.event`; wire ở `initAllBridges()`. Client renderer: `packages/desktop/src/renderer/pages/workspace/workspaceBridgeClient.ts`.
- **UI:** `WorkspaceSurfaces` (nhúng trong conversation qua `packages/desktop/src/renderer/pages/conversation/components/ConversationSurfaces.tsx`) + `SurfaceGrid`/`SurfaceFrame`;
  browser frame định vị overlay `WebContentsView`
  qua `setBounds` (ẩn khi cuộn ngoài tầm), editor frame là `UniversalEditor` read-only reload theo write.
  Composer parse 1 câu lệnh thành nhiều surface (token URL/file). Desktop-only.
- **Không đụng aioncore (Rust):** toàn bộ ở Main process + renderer, đúng "Key Architectural Decision".
- **Test:** `tests/unit/workspace/` — orchestrator parallel/lease/isolation/cancel,
  editor write/finish/abort, parser, `WorkspaceSurfaces` DOM, **`tests/unit/workspace/ConversationSurfaces.dom.test.tsx`**
  (Super state-sync với session_mcp_servers + nút Watch mở popup live-browser, KHÔNG tự mở composer).

#### Yêu cầu 6 — Bug Monitor + Auto-fix (ĐÃ NỐI DÂY ĐẦY ĐỦ)

- **Vòng khép kín**: thu lỗi → phân tích → thử vá trong sandbox cô lập → cổng duyệt (áp/rollback) → nhớ cách sửa. Tất cả ở `process/monitor/`, phơi UI qua `packages/desktop/src/process/monitor/monitorBridge.ts`, lắp ráp ở `packages/desktop/src/process/monitor/monitorWiring.ts` (đăng ký trong `initAllBridges()`).
- **Thu lỗi tự động (6.1)**: `packages/desktop/src/process/monitor/sentryErrorSource.ts` — `packages/desktop/src/sentry.ts`'s `beforeSend` đẩy lỗi runtime vào một tap pub/sub; `bugMonitor` subscribe qua tap (không init Sentry lần 2). Cộng đường người dùng tự báo (`reportFromUser`).
- **Lưu + chống trùng (6.2/6.9)**: `packages/desktop/src/process/monitor/reportStore.ts` dedup theo `signature` (strip line/col/path/số). `packages/desktop/src/process/monitor/proposalStore.ts` (MỚI) persist `PatchProposal` để recall known-fix theo id/signature → bỏ qua phân tích lại.
- **Phân tích (6.3)**: `packages/desktop/src/process/monitor/rootCauseAnalyzer.ts` + `packages/desktop/src/process/monitor/codeContextProvider.ts` (MỚI, đọc file trong stack, chỉ trong app root) + `packages/desktop/src/process/monitor/analyzerAgent.ts` (MỚI, provider-backed `/chat/completions` như companyGenerator, trả JSON `{rootCause,explanation,diff,risk}`).
- **Sandbox (6.4/6.8)**: `packages/desktop/src/process/monitor/patchValidationSandbox.ts` (MỚI) — copy file bị ảnh hưởng vào thư mục cô lập, áp diff (`diff` lib), optional command-validate, lease `patchBuild` qua ResourceCoordinator, luôn dispose. (`packages/desktop/src/process/monitor/patchSandbox.ts` cũ là bản đầy đủ chạy Windows-test 2b — chờ display/driver backend.)
- **Cổng duyệt + áp vá (6.5/6.6/6.7)**: `packages/desktop/src/process/monitor/patchGate.ts` (mặc định cần duyệt; auto-apply chỉ low-risk) + `packages/desktop/src/process/monitor/patchApplier.ts` (MỚI) — snapshot TRƯỚC khi áp, áp diff vào `app.getAppPath()`, `restore` lùi lại; KHÔNG hot-swap binary đóng gói. State files dưới `userData/monitor/`.
- **UI**: `renderer/pages/monitor/` — `packages/desktop/src/renderer/pages/monitor/MonitorPage.tsx` 2 mục (Bản vá đề xuất + Báo cáo), `packages/desktop/src/renderer/pages/monitor/components/ProposalCard.tsx` (duyệt/từ chối/rollback), hook `packages/desktop/src/renderer/pages/monitor/useMonitorState.ts`. i18n module `monitor` đủ 9 locale. Kênh `monitor.list-reports/list-proposals/report-from-user/approve-patch/reject-patch/rollback-patch`.

#### Yêu cầu 2b — Testing đa nền tảng (ĐÃ NỐI 2 MẶT PHẲNG; WEB CHẠY THẬT)

- `process/testing/` đầy đủ logic điều phối (testOrchestrator, virtualDisplayManager, scriptDriver/computerUseDriver, recorder, reportBuilder, platform targets) + UI `renderer/pages/testing/` + route `/settings/testing`. Unit/property/DOM test xanh (28/28).
- **Nối dây dùng chung 1 orchestrator singleton** (`packages/desktop/src/process/testing/testingWiring.ts`): cả UI plane lẫn Agent plane gọi cùng `getTestingServices(getWindow).orchestrator`.
  - **UI plane**: `packages/desktop/src/process/testing/testingBridge.ts` (kênh `testing.list-sessions/get-report/run/generate/detect-app` + emitter `testing.detect-progress` + `testing.generate-progress`) đăng ký trong `initAllBridges()` → boot log `[Bridge] Testing bridge registered.`. Trang Testing có form `NewSessionPanel` để người dùng tự đưa phiên kiểm thử + xem báo cáo.
    - **Phát hiện app từ source**: `appDetector.detect()` đọc các file khai báo (package.json/docker-compose/Procfile/README…) rồi hỏi model cách chạy. Hai cách dùng: (1) **AI tự nhận** — nút "Detect from source"; (2) **Thiết lập thủ công** (`testing.form.manualSetup`) — chọn folder rồi tự nhập URL/command/services qua `AppUnderTestEditor`, KHÔNG gọi model (dùng khi chưa cấu hình model hoặc AI đoán sai).
    - **Thanh tiến trình AI**: `appDetector` nhận `onProgress` phát `DetectProgress` (phase `scanning|reading|analyzing|parsing|cache|done|error`); bridge bơm qua emitter `testing.detect-progress`; renderer (`useTestingState.onDetectProgress`) hứng và render `DetectProgressBar` (Arco `Progress` + i18n `testing.detect.phase_*`) để người dùng thấy AI đang đọc file nào / làm gì. Tương tự, **tạo bước bằng AI** (`scenarioGenerator.generate`) nhận `onProgress` phát `GenerateProgress` (phase `preparing|thinking|parsing|done|error`, kèm model id khi thinking / số bước khi done) qua emitter `testing.generate-progress` → `useTestingState.onGenerateProgress` → `GenerateProgressBar` (i18n `testing.generate.phase_*`). Lưu ý: client `generate` đặt timeout **70s** (> backend 45s) để lỗi/kết quả thật thắng race, không lòi "is not available yet" giả khi model chậm.
  - **Agent plane**: `packages/desktop/src/process/testing/testingMcpHost.ts` host Testing MCP **in-process** trên loopback `127.0.0.1:<ephemeral>/sse` (SDK `SSEServerTransport`, vì orchestrator là singleton Main-process lái WebContentsView, không chạy stdio con được). `packages/desktop/src/process/testing/registerTestingMcp.ts` đăng ký vào catalog MCP (`sse`) trong `runBackendMigrations` (idempotent, update url mỗi boot). Boot log `[TestingMCP] Registered "aionui-testing"` + aioncore `imported_count=1 enabled_count=1`.
- **Web chạy thật**: tab Chromium nhúng ẩn (`browserViewManager` riêng cho test), script-engine grammar `goto/wait/assertText/assertTitle/click/type <sel> => <text>`, ảnh mốc thật qua `capturePage().toPNG()`, báo cáo `.md` ghi `userData/testing/<id>/report.md`.
- **Còn thiếu (engine OS thật)**: Android/Windows target dùng provisioner "unavailable" (reject trung thực, không fake pass) cho tới khi cắm adb/Xvfb-CreateDesktop/nut.js/ffmpeg; video encoder chưa bundle (recorder no-op video, vẫn chụp ảnh). Monitor (6) vẫn mượn lớp này (patchSandbox chạy Windows-test ẩn) — chờ engine Windows.

### Điểm bắt đầu code

```bash
# 1. Đảm bảo dependencies đã cài
bun install

# 2. Xác nhận app chạy được
bun run dev

# 3. Bắt đầu với Yêu cầu 4 (dễ nhất, không phụ thuộc)
# → Thêm vi-VN vào i18n-config.json
# → Tạo locale files
# → bun run i18n:types
```

---

## Phụ lục: Các file quan trọng cần biết

| File                                                         | Tầm quan trọng | Mô tả                                |
| ------------------------------------------------------------ | -------------- | ------------------------------------ |
| `AGENTS.md`                                                  | ⭐⭐⭐         | Quy tắc bắt buộc cho mọi contributor |
| `packages/desktop/src/common/adapter/ipcBridge.ts`           | ⭐⭐⭐         | Toàn bộ API surface                  |
| `packages/desktop/src/common/adapter/httpBridge.ts`          | ⭐⭐⭐         | HTTP/WS factory                      |
| `packages/desktop/src/common/config/storage.ts`              | ⭐⭐⭐         | Core data types                      |
| `packages/desktop/src/common/config/configService.ts`        | ⭐⭐           | Client settings service              |
| `packages/desktop/src/process/services/database/schema.ts`   | ⭐⭐           | DB schema                            |
| `packages/desktop/src/renderer/main.tsx`                     | ⭐⭐           | React app entry                      |
| `packages/desktop/src/preload/main.ts`                       | ⭐⭐           | IPC bridge                           |
| `packages/desktop/src/renderer/components/layout/Router.tsx` | ⭐⭐           | All routes                           |
| `packages/desktop/src/common/config/i18n-config.json`        | ⭐⭐           | i18n languages + modules             |
| `uno.config.ts`                                              | ⭐⭐           | Color tokens + CSS config            |
| `packages/web-host/src/index.ts`                             | ⭐             | WebHost entry                        |
| `justfile`                                                   | ⭐             | `just push` workflow                 |

---

_Tài liệu này được tạo tự động từ việc đọc codebase. Cập nhật khi có thay đổi kiến trúc lớn._

---

## 30. Spec đang mở: Personal Manager

File: `.kiro/specs/personal-manager/requirements.md`

Tính năng **Manager** — top-level app (route `/manager`, entry nav cạnh Studio) gồm 3 phần: **Tasks**,
**Note**, **Schedule**, có AI hỗ trợ. Độc lập với spec Tomni Agentic (mục 29), **không đụng aioncore**.

- **Main `process/manager/`**: `managerTypes` (Task 4 loại oneoff/recurring/habit/milestone; CalendarEvent
  lockKind fixed/flexible; Note 3 loại daily/learn/data), `managerStore` (file `manager-data.json`, ghi
  atomic + nạp phòng thủ + recurring spawn), `managerAi` (parseTasks/reviewTasks/parseSchedule/
  parseScheduleImage vision/optimizeSchedule **giữ nguyên lịch cứng** + researchTopic/summarizeDocument,
  qua `providerChat` + lease ResourceCoordinator), `weatherProvider` (Open-Meteo, không cần khoá, degrade),
  `travelProvider` (thời gian di chuyển 3 tầng: Google Geocoding+Distance Matrix khi có API key → keyless
  OSM geocode + OSRM route → ước lượng haversine÷tốc-độ; degrade-safe, ghi `source`; nuôi buffer commute cho
  `optimizeSchedule`), `webSearch` (keyless — Wikipedia REST + DuckDuckGo, chạy Main tránh CORS, degrade),
  `reminderScheduler` (ticker 60s + catch-up nhắc quá hạn qua `showNotification`, KHÔNG dùng cron aioncore),
  `managerBridge` (kênh `manager.*`, envelope `ManagerResult` luôn-resolve; `computeTravelLegs` gom leg theo
  ngày + leg-từ-home cho event đầu ngày), `managerWiring`, `registerManagerMcp`. `ManagerSettings` lưu
  `weatherEnabled`/`defaultLocation` + `travelTimeEnabled`/`travelMode`/`googleMapsApiKey`/`homeLocation`
  (key lưu cục bộ trong `manager-data.json`, không upload).
- **Agent plane**: `packages/desktop/src/process/resources/builtinMcp/managerServer.ts` (stdio, 6 tools: list/add/update task, add note,
  list/add event; cùng `manager-data.json` qua env `AIONUI_MANAGER_DATA_DIR`); esbuild entry
  `out/main/builtin-mcp-manager.js`; đăng ký vào catalog ở `runBackendMigrations` (`ensureManagerMcpRegistered`).
- **Renderer `pages/manager/`**: ManagerPage (3 tab Arco: Tasks/Notes/Schedule) + `tasks/`/`notes/`/`schedule/`;
  Notes chia 3 loại **Daily** (nhật ký) / **Learn** (Obsidian-style, `[[wiki]]` link + backlink qua
  `notes/editor/LearnLinksFooter`, **graph view** liên kết qua `notes/linking/{linkGraph,LinkGraphView}`
  (SVG force-directed tự viết, kéo/click/highlight, không thêm dep) + nghiên cứu AI) / **Data** (thư viện tài liệu,
  mở nguồn URL qua `openExternalUrl`/file qua `ipcBridge.shell.openFile`). **Mọi loại note soạn trong full-page
  editor kiểu Notion** `notes/editor/NotePageEditor` (overlay): cover/icon/title + block body kéo-thả qua
  `notes/editor/{NotePage,NoteBlockEditor}` (BlockNote, slash menu/table/media) + hàng thuộc tính inline
  `notes/editor/NoteProperties` (tags, link task/event; Data thêm URL/file + AI summarize). Tạo note lười (empty note,
  bỏ nếu để trống). Hook `useManagerStore` có `mutate()` trả về document mới (create-then-open). Tasks có `RecurrenceEditor`
  (freq+interval) trong TaskEditor + `ReviewTasks` (AI rà soát: overdue/priority/merge/split/order, read-only).
  Schedule có `ManagerSettingsModal` (weather + travel-time + Google key + home + mode) và `OptimizePanel`
  hiện travel legs (phút/km + nhãn "ước lượng"). UI Arco + UnoCSS semantic token + i18n module `manager`
  (9 locale). AI đề xuất → xem trước → lưu; tối ưu lịch có undo + giữ nguyên lịch cứng.
  Workspace-wide (Notion/Todoist-class): `packages/desktop/src/renderer/pages/manager/components/appearance.ts`+`AppearanceModal` (accent/font/density/size/tinted
  → CSS vars scoped trên root), `components/CommandPalette` (Ctrl/Cmd+K tìm xuyên task/note/event), `tasks/quickAddParser`+`QuickAdd`
  (quick-add ngôn ngữ tự nhiên: `!ưu-tiên`, `#tag`, "mai 5pm"/"thứ 2 9h", không AI).

Trạng thái: code Tasks/Notes/Schedule done (unit/DOM test pass, tsc sạch phần manager, i18n đủ key). Nghiệm
thu UI thật do người dùng tự chạy `bun start` — KHÔNG dùng Claude/computer-use (xem
`.kiro/steering/claude-ui-testing.md`). Chi tiết tiến độ ở `.kiro/status.md`.

---

## Callout 2026-06-09 — Realtime Knowledge + Smart Terminal (production-grade)

**Realtime Knowledge (RTK)** — kho kiến thức _sự kiện dễ lỗi thời_ (versions/prices/role holders/spec…),
chống AI trả lời cũ. Backend Main-process thuần TS, KHÔNG đụng aioncore:

- `packages/desktop/src/process/knowledge/realtime/` — `rtkTypes`, `freshness`, `embeddingText`,
  `rtkStore` (atomic JSON ở `userData/knowledge/realtime`), `rtkVectorIndex` (cosine + `Embedder`),
  `verificationService` (guardrail: đủ nguồn độc lập mới ghi đè), `refreshPipeline` (crawl→verify→diff),
  `rtkScheduler` (croner refresh hết hạn), `rtkService` (facade lookup/record/refresh/relate/list),
  `staleDetector`.
- `process/knowledge/`: `rtkEmbedder` (provider embedding + hashing fallback), `rtkWiring` (singleton),
  `realtimeKnowledgeBridge` (`rtk.list/lookup/refresh/relate` — wire ở `initAllBridges`), MCP
  `aionui-realtime-knowledge` (`rtk_lookup/rtk_record/rtk_refresh`, SSE host + register ở
  `runBackendMigrations`).
- Renderer: `renderer/pages/knowledge/` (inspector, route `/settings/knowledge`, desktop-only) +
  i18n module `realtimeKnowledge`. `superGuidance.withRealtimeKnowledgeRules` dạy agent lookup→verify→record.

**Smart Terminal** — terminal của app tự thông minh (không dựa MTUI):

- docTerminal `process/terminal/commandDoc/` — học lệnh khi `command-end exitCode=0`, gợi ý ghost-text
  (prefix+frequency+recency, scorer pure renderer-safe), Tab-accept. Bridge `terminal.cmd-snapshot`/
  `terminal.cmd-capture`; redact secret trước khi lưu.
- Smart Fix `process/terminal/smartFix/` — `commandRemap` (seed `gemini→agi` + RTK resolver
  `cmd.remap.<program>`), bridge `terminal.cmd-remap`. Lệnh lỗi → notice + nút **Run với <new>**
  (1-click, KHÔNG auto-rerun — an toàn). i18n module `smartTerminal`.
- Renderer: `useTerminalIntelligence` + `TerminalView` (ghost overlay + smartfix notice), `commandDocClient`.

**Lưu ý i18n quan trọng:** module mới PHẢI được import + export trong **cả 9** `renderer/services/i18n/
locales/*/index.ts` (loader nạp qua default export của index.ts, KHÔNG tự sinh) — nếu chỉ thêm JSON +
`packages/desktop/src/common/config/i18n-config.json` thì key sẽ KHÔNG nạp lúc chạy. (Đã sửa cho `realtimeKnowledge`, `system`, `smartTerminal`.)

**Verify:** `tests/unit/{terminal,knowledge}` 164/164 pass; `bunx tsc --noEmit` **0 lỗi toàn dự án**;
`generate-i18n-types` + `check-i18n` PASS. Spec: `.aionui/specs/{realtime-knowledge,smart-terminal}/`.
