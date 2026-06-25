# Tasks — Smart Terminal

> `[ ]` chưa làm · `[x]` xong · `[-]` bỏ qua. Ràng buộc: Main-process backend (không Node API ở
> renderer), KHÔNG sửa aioncore, fs/Embedder DI, tsc sạch trong phạm vi.

## Phase 1 — Backend pure + store

- [ ] 1.1 `commandTypes.ts` — `CommandRecord`, `CommandSuggestion`, trọng số scoring (PURE).
- [ ] 1.2 `commandRedact.ts` — che secret trong lệnh trước khi lưu (PURE).
- [ ] 1.3 `commandClassify.ts` — tách `program` + `args` (PURE).
- [ ] 1.4 `commandScore.ts` — prefix + frequency + recency (+vector optional) → rank (PURE).
- [ ] 1.5 `commandDocStore.ts` — persist commandDoc.json (atomic, fs DI).
- [ ] 1.6 `commandDocService.ts` — facade capture/suggest/topK (+ Embedder optional).
- [ ] 1.7 Test Phase 1 — redact/classify/score/store/service.

## Phase 2 — Capture + suggest bridge

- [ ] 2.1 `commandDocBridge.ts` — kênh `terminal.cmd-capture` / `terminal.cmd-suggest`.
- [ ] 2.2 Wire `initAllBridges()` + client `terminalBridgeClient` thêm cmd invokers.
- [ ] 2.3 TerminalView: trên `command-end(exitCode=0)` + `command-line` → gọi capture.

## Phase 3 — Ghost-text UI

- [ ] 3.1 `useCommandDoc.ts` — theo dõi dòng đang gõ (keydown), gọi suggest, Tab-accept.
- [ ] 3.2 `GhostSuggestion.tsx` — overlay ghost-text mờ tại con trỏ (Arco/UnoCSS, reduced-motion).
- [ ] 3.3 Tích hợp vào TerminalView (giữa prompt-end..command-start).

## Phase 4 — Smart fix

- [ ] 4.1 `commandRemap.ts` — program + RTK facts/seed → replacement + updateUrl (PURE).
- [ ] 4.2 `smartFixService.ts` — gọi rtkService + seed built-in (gemini→agi).
- [ ] 4.3 `SmartFixNotice.tsx` + `useSmartFix.ts` — nghe command-end≠0 → notice + nút Run với <new>.

## Phase 5 — i18n + settings + tests

- [ ] 5.1 i18n module mới (hoặc mở rộng `terminal`) 9 locale cho ghost/notice.
- [ ] 5.2 Tuỳ chọn `autoRerun` (mặc định tắt) trong Settings › Terminal.
- [ ] 5.3 DOM test ghost-text + smart-fix notice.

## Checkpoints

- [ ] CP1 (Phase 1): test pure/store/service pass, tsc sạch.
- [ ] CP2 (Phase 2-3): capture thật khi lệnh thành công + ghost-text Tab-accept hoạt động.
- [ ] CP3 (Phase 4-5): smart-fix notice + remap RTK + i18n/tests.
