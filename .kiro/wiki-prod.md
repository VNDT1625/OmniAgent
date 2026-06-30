# Wiki Production-Grade — Log riêng (KHÔNG ghi vào status.md)

> Người dùng yêu cầu: nâng IDE/Wiki lên production-grade. Pipeline mới:
>
> 1. Bước khởi động: Agent đọc doc nhưng KHÔNG tin doc — kiểm chứng doc với code thật.
>    Doc sai thì TỰ SỬA doc trước.
> 2. Gọi "agent khác" viết wiki TỪ doc đã verify.
> 3. Lưu wiki xuống đĩa — sống qua restart, dùng lại được.
> 4. Vòng lặp: code → test → tự đánh giá → cải thiện → test, tới khi "không còn tối ưu được nữa".
> 5. Mọi quyết định tự quyết, không hỏi lại. Ghi log vào FILE NÀY, không đụng status.md.

## Hiện trạng đầu phiên (đã có sẵn từ phiên trước, ĐÃ TEST 43 pass)

- `packages/desktop/src/process/ide/wiki/docVerify.ts` (PURE): verify doc claims (file-path refs + npm script refs)
  vs RepoFacts; tự sửa moved-path (unique basename) + near-miss script (edit-distance ≤2);
  trả issues + corrected markdown. → "trust but verify".
- `packages/desktop/src/process/ide/wiki/wikiStore.ts`: persist `PersistedWiki` (app store userData + repo export
  `.aionui/wiki/`), atomic tmp+rename, fs injected. → lưu sống qua restart.
- `packages/desktop/src/process/ide/wiki/wikiBootstrap.ts`: pipeline scanning→verifying→fixing→planning→writing→saving,
  deps injected. Hiện viết MỖI section 1 lần (chưa có vòng lặp tự đánh giá).
- Test: `tests/unit/ide/wiki/{docVerify,wikiStore,wikiBootstrap}.test.ts` + wikiPlanner + WikiPanel.dom
  = 5 file, 43 pass.
- CHƯA wire bridge, CHƯA có critic/refine loop, CHƯA nối renderer (useRepoWiki/WikiPanel vẫn dùng
  flow plan+section cũ, không persist).

## Việc cần làm (phiên này)

- [x] A. `packages/desktop/src/process/ide/wiki/wikiCritic.ts` (PURE) — critiqueSection (placeholder/too-short/hallucinated-path/low-grounding/
      missing-diagram/no-subheadings/duplicate-title/missing-coverage) + hasConverged. diagnostics sạch.
- [x] B. `packages/desktop/src/process/ide/wiki/wikiRefine.ts` — refineSection: draft→critique→improve giữ best, dừng khi hội tụ. diagnostics sạch.
- [x] C. Tích hợp refine vào `wikiBootstrap`: per-section quality+iterations, mean quality vào PersistedWiki;
      đổi `facts`→`repoFacts` tránh shadow. Test wiki cũ 43 vẫn pass.
- [x] D. Bridge `packages/desktop/src/process/ide/wiki/wikiBuildBridge.ts`: `ide.wiki-build`/`ide.wiki-load` + emitter `ide.wiki-progress`,
      wire Node fs (collectRepoFiles + fsp), runIdeChat, wikiStore(userData/ide-wiki + sha1 hash). Đăng ký
      ở `initAllBridges()` ('IDE wiki-build bridge'). diagnostics sạch.
- [x] E. ideClient: +wikiBuild/wikiLoad/onWikiProgress (+types). useRepoWiki: viết lại flow persistent
      (load on open + build với phase progress + docReports/quality/persisted). WikiPanel: viết lại
      (phase strip, documentation-check report, saved badge, evidence string[]). DOM test viết lại.
- [x] F. i18n: +ide.wiki.{phase\_\*,building,loadingSaved,buildFailed,reportTitle,verifiedDocs,docsFixed,
      docsClean,quality,savedBadge,savedAt,refinedTooltip} ở 9 locale. i18n:types in-sync, check-i18n PASS.
- [x] G. Tự đánh giá & cải thiện tới hội tụ: - Sửa lỗi đúng đắn: critic coverage chấm bằng từ khóa tiếng Anh → phạt oan wiki non-English →
      gate coverage chỉ khi prose English (wikiBootstrap). +test critic briefKeywords=[]. - Sửa TS7018 ở useRepoWiki (annotate return của map callback). - Dọn lint: 3 lỗi unicorn (Array.from thay new Array, startsWith thay regex) + 4 justify
      no-await-in-loop (refine/bootstrap/store tuần tự có chủ đích) → oxlint 0/0. - Thêm test bootstrap "records per-section quality and refines a weak section".

## Kết quả cuối (production-grade ĐẠT)

- Pipeline: đọc doc → KHÔNG tin, verify với code → tự sửa doc (ghi lại đĩa, hiện trong report) →
  writer agent viết từ doc đã verify → critic tự đánh giá → refine tới hội tụ → lưu bền (userData +
  repo export) → mở lại load tức thì.
- Verify: `tests/unit/ide/wiki` 7 file **66 pass** (docVerify/wikiStore/wikiBootstrap/wikiPlanner/
  wikiCritic/wikiRefine + WikiPanel.dom); toàn `tests/unit/ide` **505 pass / 8 skip**; `bunx tsc --noEmit`
  SẠCH; oxlint phạm vi wiki **0/0**; i18n:types in-sync + check-i18n PASS (9 locale, không thiếu ide.wiki).
- Đã cập nhật `docs/CODEBASE_GUIDE.md` (callout 2026-06-09 "IDE Wiki production-grade" + sửa mô tả mode Wiki + registry).
- Quyết định bỏ qua (diminishing returns, không thuộc yêu cầu): staleness detection (đã có builtAt +
  Regenerate, scan-on-open quá đắt); nút Cancel build; stream nội dung từng mục (đã có phase detail).
  Đánh giá: đã đạt điểm "không còn tối ưu được nữa" cho phạm vi yêu cầu.
