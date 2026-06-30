# Memory — Realtime Knowledge + Smart Terminal (ghi nhớ cho agent kế tiếp)

> Thông tin cần-nhớ để tiếp tục 2 feature: **Realtime Knowledge (RTK)** và **Smart Terminal**
> (docTerminal + Smart Fix). Cập nhật gần nhất: 2026-06-09.
> Đọc kèm `docs/session/realtime/status.md` (việc đã/chưa xong) và spec
> `.aionui/specs/{realtime-knowledge,smart-terminal}/`.

## Quy ước / cạm bẫy quan trọng (đọc trước khi sửa)

- **Shell = `cmd` trên Windows. Output bị mangle + luôn báo `Exit Code: -1`** dù lệnh chạy xong.
  Cách dùng: ghi ra file `.kiro\*.txt` rồi `powershell Select-String`. Dọn temp sau khi xong.
  ĐỪNG tin exit code của wrapper; xác minh bằng nội dung output. Ưu tiên `getDiagnostics`/`read_file`/
  `grep_search` thay cho lệnh terminal.
- **`tsc` toàn repo: dùng `bunx tsc --noEmit > .kiro\tsc.txt 2>&1` (CHỈ redirect, KHÔNG nối `;`/
  `&&` vào — cmd sẽ truyền chúng thành path cho tsc → lỗi giả `Could not resolve path ';'`).**
- **i18n — CẠM BẪY LỚN:** thêm module mới KHÔNG chỉ là tạo JSON + thêm vào `i18n-config.json`.
  Loader (`renderer/services/i18n/index.ts`) nạp qua **default export của từng `locales/<lng>/index.ts`**
  (static import, KHÔNG tự sinh). Nếu quên thêm `import x from './x.json'` + entry vào cả **9**
  index.ts → key KHÔNG nạp lúc chạy (UI hiện raw key) DÙ `check-i18n` vẫn PASS (nó chỉ validate JSON,
  không validate index.ts). `generate-i18n-types` sinh `i18n-keys.d.ts` từ JSON theo config.
  → Quy trình đúng khi thêm module: tạo 9 JSON → thêm vào `i18n-config.json` modules → thêm import+
  export vào **9** `locales/*/index.ts` → `node scripts/generate-i18n-types.js` → `node scripts/check-i18n.js`.
- Process boundary: renderer KHÔNG Node API; main KHÔNG DOM API. IPC qua `@office-ai/platform`
  `bridge.buildProvider/buildEmitter`. Bridge Node-only KHÔNG được import vào renderer runtime —
  renderer rebuild invoker từ **chuỗi tên kênh** + chỉ `import type` (xem `commandDocClient.ts`,
  `realtimeKnowledgeBridgeClient.ts`).
- UI: Arco + `@icon-park/react` + UnoCSS semantic token (`bg-bg-2`, `text-t-primary`, `b-line-2`,
  `bg-fill-1..4`, `text-success/warning/danger`...) + i18n. KHÔNG raw HTML interactive, KHÔNG hardcode màu.
  **Icon @icon-park: kiểm tra export tồn tại** (đã gặp `Database`/`Battery` KHÔNG export → crash; dùng
  `DataSheet`/`Lightning`/`Refresh` đã xác nhận tồn tại).
- Mỗi thư mục ≤ 10 children. `process/terminal/commandDoc/` đang 8 file (còn chỗ); `process/knowledge/
realtime/` đang 10 file (ĐẦY — thêm logic mới nên gộp vào file có sẵn, đừng tạo file thứ 11).

## Realtime Knowledge (RTK) — kiến trúc (ĐÃ HOÀN THIỆN core)

Mục tiêu: chống AI trả lời bằng kiến thức lỗi thời (version/price/role/spec/stat...). Backend Main-process
thuần TS, KHÔNG đụng aioncore.

- `process/knowledge/realtime/` (PURE + store + engine): `rtkTypes`, `freshness` (TTL theo
  `volatilityClass`, stale ở 75% TTL), `embeddingText`, `rtkStore` (atomic JSON `userData/knowledge/
realtime/facts.json`, fs DI), `rtkVectorIndex` (cosine + `Embedder`, fingerprint FNV skip re-embed),
  `verificationService` (**guardrail FR7**: đếm host độc lập + agreement, change cần ≥2 nguồn, confirm ≥1),
  `refreshPipeline` (researcher + extractValue inject), `rtkScheduler` (croner, re-entrancy guard, backoff),
  `staleDetector` (PURE), `rtkService` (facade: `lookup/record/refresh/refreshExpired/relate/list`;
  `applyDecision` PURE đẩy giá trị cũ vào `history`).
- `process/knowledge/`: `rtkEmbedder` (provider embedding model + **hashing fallback** renderer-safe),
  `rtkWiring` (singleton + persist index), `realtimeKnowledgeBridge` (`rtk.list/lookup/refresh/relate`),
  MCP `aionui-realtime-knowledge` (`rtk_lookup/rtk_record/rtk_refresh`, SSE host + register ở
  `runBackendMigrations` qua `ensureRealtimeKnowledgeMcpRegistered`).
- Renderer: `pages/knowledge/` (inspector `/settings/knowledge`, desktop-only) + i18n `realtimeKnowledge`.
  `superGuidance.withRealtimeKnowledgeRules` dạy agent: lookup trước → verify bằng web tool → record.

**Quyết định thiết kế then chốt:** RTK theo mô hình **"agent là người crawl"** — agent dùng web/browser
tool của nó để xác minh rồi gọi `rtk_record` kèm `sources`; RTK áp guardrail (đủ nguồn mới ghi đè, giữ
history). `refreshPipeline.researcher` để **inject/optional**: chưa wcrawl tự động (xem #3 trong status).
Remap lệnh lỗi thời lưu dạng RTK fact `topic = cmd.remap.<program>` (Smart Fix đọc).

## Smart Terminal — kiến trúc (core ĐÃ XONG; 3 enhancement xem status)

- **docTerminal** `process/terminal/commandDoc/` (8 file): học lệnh khi `command-end exitCode=0`,
  gợi ý ghost-text (prefix+frequency+recency, scorer PURE renderer-safe), Tab-accept. Redact secret
  trước khi lưu (`redactSecrets`: flag token/password, URL creds, opaque key).
  - **CONTRACT TEST `tests/unit/terminal/commandDoc/commandDoc.test.ts` LÀ NGUỒN CHÂN LÝ API.** Nếu
    đổi API phải giữ test này xanh (hoặc cập nhật có chủ đích). API: `redactSecrets`, `classifyCommand`/
    `replaceProgram` (program = basename; env `KEY=VAL` tách riêng), `matchScore`(→{score,isPrefix})/
    `rankCommands(records,{prefix,now},limit)`/`bestGhost`, store `readAll/writeAll`, service
    `createCommandDocService({store,now,schedule})` → `init/capture(SYNC)/snapshot/suggest/ghost/flush`
    (capture schedule **coalesced** flush; DI `schedule`). `CommandRecord` có `program` + `cwd?` (optional).
  - Bridge kênh **`terminal.cmd-snapshot`** (KHÔNG phải `cmd-list`) + `terminal.cmd-capture`. Renderer
    `commandDocClient.ts` + `useTerminalIntelligence.ts` (rank cục bộ, ghost ở `TerminalView`).
- **Smart Fix** `process/terminal/smartFix/`: `commandRemap` (seed `gemini→agi` + RTK resolver
  `cmd.remap.<program>`), `smartFixBridge` (`terminal.cmd-remap`, re-export type `Remap`),
  `smartFixPrompt` (PURE: `interpretConfirmKey`/`buildConfirmPrompt` — cho enhancement auto-rerun).
  Lệnh lỗi → notice ở `TerminalView` (errorLine + updated→ + link) + nút **Run với `<new>`** 1-click
  (`onInput(replacementCommand + '\r')`, disabled khi session không chạy). i18n `smartTerminal`.

## Lệnh hay dùng

- Test nhóm: `bunx vitest run tests/unit/terminal/commandDoc` · `tests/unit/terminal/smartFix` ·
  `tests/unit/knowledge`
- i18n: `node scripts/generate-i18n-types.js` + `node scripts/check-i18n.js`
- Typecheck: `getDiagnostics` trên file (nhanh) hoặc `bunx tsc --noEmit > .kiro\tsc.txt 2>&1` (toàn repo).
- Nếu test fail kiểu `X is not defined`/`load is not a function` ở file không sửa → xóa cache Vite
  `rmdir /s /q node_modules\.vite` rồi chạy lại (lỗi giả, không phải code).
