# Status — Realtime Knowledge + Smart Terminal (handoff)

> Cập nhật: 2026-06-09. Đọc kèm `docs/session/realtime/memory.md` + spec
> `.aionui/specs/{realtime-knowledge,smart-terminal}/`.
> File này nói rõ: ĐÃ xong, ĐANG dở, CHƯA bắt đầu, và lỗi/giới hạn — để agent khác tiếp tục.

## ✅ Đã xong & verify (không cần làm lại)

### Realtime Knowledge (RTK) — Phase 1–4 hoàn chỉnh

- Backend `process/knowledge/realtime/` (10 file) + `rtkEmbedder`/`rtkWiring`/`realtimeKnowledgeBridge`
  - MCP `aionui-realtime-knowledge` (register ở `runBackendMigrations`). 4 cơ chế: (a) vector lookup +
    freshness/sources, (b) scheduler refresh hết hạn, (c) staleDetector + verify-trước-khi-ghi,
    (d) query→lookup→ground→verify→update. Guardrail FR7 + relation graph (relate supersedes/contradicts).
- Renderer inspector `pages/knowledge/` (`/settings/knowledge`, desktop-only) + i18n `realtimeKnowledge`
  9 locale + `superGuidance.withRealtimeKnowledgeRules`.

### Smart Terminal — core (docTerminal + Smart Fix) hoàn chỉnh

- `process/terminal/commandDoc/` (8 file) đã conform đúng contract `commandDoc.test.ts` (19 test xanh).
  Bridge `terminal.cmd-snapshot`/`cmd-capture`; renderer `commandDocClient` + `useTerminalIntelligence`
  - ghost-text/notice trong `TerminalView`.
- `process/terminal/smartFix/` (`commandRemap` seed gemini→agi + RTK resolver, `smartFixBridge`).
- i18n module **`smartTerminal`** (9 locale) đã tạo + đăng ký vào i18n-config **VÀ** cả 9
  `locales/*/index.ts` (đồng thời sửa luôn bug: `realtimeKnowledge` + `system` trước đây cũng thiếu
  trong index.ts → đã thêm).

### Verify ở lần chốt

- `tests/unit/{terminal,knowledge}`: **164/164 pass** (commandDoc 19 + commandRemap 9 + RTK + DOM inspector).
- `bunx tsc --noEmit`: **0 lỗi toàn repo** (đã sửa luôn 4 lỗi pre-existing: icon `Battery`→`Lightning`,
  Arco `Empty` bỏ children, 2 TS7011 `()=>undefined`→`()=>{}`).
- `generate-i18n-types` + `check-i18n`: PASS.

## 🚧 ĐANG DỞ — Enhancement #2: auto-rerun toggle + Y/N confirm (≈20%)

Yêu cầu người dùng: thêm **toggle auto-rerun**; khi phát hiện remap (gemini→agi) phải có **fallback hỏi
`(Y/N)` ngay trong terminal** (để AGENT đang lái terminal cũng trả lời được bằng cách gõ y/n, không chỉ
bấm nút GUI). **Mặc định auto-rerun TẮT** (an toàn, không tự chạy lệnh user không gõ).

ĐÃ làm:

- `process/terminal/smartFix/smartFixPrompt.ts` (PURE): `interpretConfirmKey` (y/Y→accept; n/N/Esc→reject;
  Enter KHÔNG default-yes; khác→ignore), `buildConfirmPrompt`, `buildAckLine`. + test
  `tests/unit/terminal/smartFix/smartFixPrompt.test.ts` — **đã chạy: `tests/unit/terminal/smartFix` 15/15 pass**
  (commandRemap 9 + smartFixPrompt 6).
- `TerminalView.tsx`: đã THÊM prop `autoConfirm?: boolean` vào `TerminalViewProps` (mới chỉ khai báo).

CÒN LẠI (để hoàn tất #2):

1. **TerminalView**: destructure `autoConfirm`; thêm `awaitingConfirmRef` + `onDismissRemapRef`. Effect
   theo dõi `pendingRemap` + `autoConfirm`: khi remap xuất hiện & autoConfirm → `termRef.current?.write(
buildConfirmPrompt(from,to,{tag,question}))` + set awaiting. Khi remap=null → clear awaiting.
2. Trong `handleInputData`, XỬ LÝ awaiting TRƯỚC ghost/Tab: `interpretConfirmKey(data)` →
   accept: `onInputRef.current(`${replacementCommand}\r`)` + write ack + clear awaiting + `onDismissRemap`;
   reject: write ack "skipped" + clear + dismiss; ignore: clear awaiting + cho key đi tiếp bình thường.
   (Nuốt phím y/n/Esc, KHÔNG forward xuống pty.)
3. **i18n `smartTerminal.json`** (9 locale): thêm `smartFix.tag` ("Smart Fix"), `smartFix.confirmQuestion`
   (vd "run `{{program}}`? (y/N)"), `smartFix.skipped`, `smartFix.running` ({{program}}). Rồi
   `generate-i18n-types` + `check-i18n`.
4. **Toggle UI + persist**: dùng `localStorage` key (vd `aionui.terminal.smartFixAutoRerun`, mặc định
   false) — KHÔNG cần config bridge. Thêm `Switch` (Arco) ở header `TerminalPage.tsx` (i18n
   `smartTerminal.autoRerunLabel`). `useTerminalIntelligence` hoặc `TerminalPage` đọc localStorage →
   truyền `autoConfirm` xuống `TerminalView`.
5. Test: smartFixPrompt (đã có). Cân nhắc DOM test cho TerminalPage toggle (xterm khó mock → có thể chỉ
   test phần pure + localStorage helper).

## ❌ CHƯA bắt đầu — Enhancement #1: vector layer cho gợi ý lệnh

- Ý: dùng embedding để gợi ý theo NGỮ NGHĨA (không chỉ prefix). RTK đã có `Embedder` + hashing fallback
  renderer-safe (`rtkEmbedder.createHashingEmbedder`) — tái dùng được ở renderer.
- Vướng: `commandScore.rankCommands` hiện KHÔNG nhận vector (đã bỏ khi conform contract). Thêm lại
  `vectorSim?: Map<string,number>` vào `RankOptions` + 1 weight là **additive, không phá contract**
  (`commandDoc.test.ts` chỉ check thứ tự, không pass vectorSim). Hot-path ghost (`bestGhost`) là prefix-only
  nên vector ít tác dụng ở đó.
- **Vướng UI:** hiện chỉ có ghost-text inline, CHƯA có dropdown/palette gợi ý nhiều lệnh → vector chưa có
  "bề mặt" thật. Muốn payoff thật phải: (a) thêm weight vector vào rankCommands + util vectorize
  renderer-safe (hashing rẻ, hoặc gọi embedding model qua IPC nếu chấp nhận async), VÀ (b) thêm
  dropdown gợi ý top-K dưới con trỏ trong `TerminalView` (định vị giống ghost overlay đã có).
- Khuyến nghị: làm engine (rankCommands+vectorSim) + test trước; dropdown UI sau.

## ❌ CHƯA bắt đầu — Enhancement #3: auto-researcher cho RTK

- Ý: RTK tự đi web cập nhật fact hết hạn (thay vì chỉ "agent là người crawl").
- Vướng kiến trúc: `deepResearch` (đa nguồn, citation) bị ràng buộc **cửa sổ browser** (hidden tab +
  `WebContentsView`), tạo trong `browserBridge.ts`, KHÔNG có accessor singleton nhẹ. `contentExtract`
  KHÔNG fetch URL trần (chỉ convert content có sẵn).
- Hướng khả thi (không cần cửa sổ browser): viết `process/knowledge/rtkResearcher.ts` dùng **Node global
  `fetch`** lấy HTML các `sources` URL của fact + `process/browser/research/readability.extractReadable`
  (kiểm tra import standalone được) trích text + model (provider chat như `knowledgeGraphBridge.defaultChat`)
  distill giá trị mới → trả `{answer, sources}` khớp interface `RtkResearcher`. Wire optional vào
  `rtkWiring` (truyền `pipeline` cho `createRtkService`). Tôn trọng lease/ResourceCoordinator + timeout.
- An toàn: vẫn qua guardrail FR7 (đủ nguồn mới ghi đè); fact mâu thuẫn → `needs_review`.

## 🚫 Lỗi/giới hạn cần biết

- Không có lỗi tồn đọng thuộc RTK/Smart Terminal ở lần chốt (tsc 0 lỗi).
- **CHƯA chạy full `bun run test`** (mọi module) hay e2e trong phiên — chỉ chạy `tests/unit/{terminal,
knowledge,news,resource,workspace}` + tsc toàn repo + i18n. Agent kế tiếp nên chạy full suite trước release.
- Nhắc lại cạm bẫy i18n index.ts (xem memory.md) — dễ quên nhất.
