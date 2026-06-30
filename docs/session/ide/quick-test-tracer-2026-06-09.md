# Phiên làm việc — Quick Test Tracer (2026-06-09)

> Bản ghi phiên cho feature **Quick Test Tracer** của Omni IDE. Mục tiêu phiên:
> kiểm tra feature có thật sự hoạt động không (chỉ tin codebase + test thật), sau đó
> hoàn thiện tới mức "không còn tối ưu được nữa" theo vòng lặp
> code → test → tự đánh giá → cải thiện.

## 1. Bối cảnh & phát hiện ban đầu

Khi bắt đầu, `quickTestTracer.ts` trên đĩa đang ở trạng thái **refactor dở dang** (tách
buffer-policy sang `quickTestBuffer.ts` nhưng chưa hoàn tất) nên **không compile**:

- `push` vẫn tham chiếu `MAX_EVENTS` đã bị xóa → `TS2304: Cannot find name 'MAX_EVENTS'`.
- Type `QuickTestTracer` thêm `hasError()` + `recordedCount()` nhưng object trả về chưa
  implement → `TS2739`.
- `mapNavigate` thêm mới nhưng chưa wire vào switch CDP; import `isErrorEvent`/`pushBounded`
  chưa dùng.

Triệu chứng test: chạy riêng `quickTestTracer.test.ts` lúc đầu pass (do cache transform cũ),
nhưng chạy cả suite hoặc sau khi xóa cache thì **5 test FAIL** `ReferenceError: MAX_EVENTS is
not defined`.

## 2. Đã làm (theo thứ tự)

### Bước 0 — Fix compile

Hoàn tất refactor: `push` dùng `pushBounded`; thêm state `recorded`/`errorSeen`; implement
`hasError`/`recordedCount`; wire `case 'Page.frameNavigated'`. Native tracer bỏ `MAX_EVENTS`
cục bộ, dùng chung `pushBounded`.

### 7 vòng hoàn thiện (code → test → tự đánh giá → cải thiện)

1. **Bug navigate (web):** listener DOM mất sau khi trang điều hướng vì guard
   `window.__omniQtListening` chỉ inject 1 lần lúc start. Tách `DOM_LISTENER_SCRIPT` +
   `injectDomListeners`, re-inject khi `Page.frameNavigated` (chỉ top-frame; bỏ qua
   sub-frame và `about:blank`).
2. **Bug streaming (bridge):** cũ dùng `setInterval` 200ms + index `lastStreamedCount` vào
   buffer — sai khi smart-eviction splice giữa mảng (>150 event). Thay bằng **push-based**:
   thêm dep `onEvent` cho cả hai tracer; bridge wire `onEvent → emit`, bỏ hẳn polling.
3. **Bug significance (buffer):** click/input trước lưu dưới dạng console log `[omni-qt-*]`,
   chỉ parse lúc `stop()` → `isSignificantEvent` = false → bị evict TRƯỚC khi parse mất cả
   interaction path. Sửa: `parseDomMarker` ngay lúc record → vào buffer dạng `click`/`input`
   (significant → được giữ + stream đúng).
4. **Error precedence:** `isErrorEvent` cũ chỉ tính network `status >= 400`. Bổ sung
   transport failure (network `status: 0` + `error`, vd `ECONN`/DNS/timeout) → early-exit +
   thành `firstError` + được map context. Đồng bộ điều kiện ở `traceContextBuilder`.
5. **IPC flood:** bridge giờ chỉ stream event **significant** (click/input/navigate/error)
   tới live view; log thường + response 2xx vẫn lưu trong trace (cho `stop()`) nhưng không
   stream → trang ồn không làm ngập IPC. Đã xác minh renderer `QuickTestPanel.liveEvents` chỉ
   là feed "đang ghi", kết quả cuối lấy từ `qtStop().trace` đầy đủ → không lệch.
6. **Đồng nhất contract:** web + native tracer đều có `hasError()` (O(1)) +
   `recordedCount()` (monotonic) + `onEvent`. Service `runSession` early-exit dùng
   `tracer.hasError()` thay vì rescan `findFirstError(currentEvents())` mỗi vòng poll.
7. **Test + coverage:** thêm `quickTestBuffer.test.ts` (mới) + `quickTestBridge.test.ts`
   (mới, mock `@office-ai/platform` theo pattern `testingBridge.test.ts`) + mở rộng
   tracer/native/service/builder. Dọn lint (eslint-disable cho `no-await-in-loop` ở vòng
   poll, bỏ import `TraceEvent` thừa ở `traceContextBuilder`).

## 3. File đã đổi

Source (`packages/desktop/src/process/ide/`):

- `quickTestTracer.ts` — push/onEvent, hasError/recordedCount, navigate + re-inject,
  parseDomMarker (record-time), stop đơn giản hóa.
- `quickTestNativeTracer.ts` — pushBounded, hasError/recordedCount/onEvent, bỏ MAX_EVENTS.
- `quickTestBuffer.ts` — `isErrorEvent` tính transport failure; `isSignificantEvent` gọn lại.
- `quickTestBridge.ts` — push-stream qua onEvent, chỉ stream significant, bỏ polling.
- `quickTestService.ts` — early-exit qua hasError(), bỏ import findFirstError thừa.
- `traceContextBuilder.ts` — map cả failed request (status 0 + error), bỏ import thừa.

Test (`tests/unit/ide/`):

- `quickTestBuffer.test.ts` (mới), `quickTestBridge.test.ts` (mới),
  `quickTestTracer.test.ts`, `quickTestNativeTracer.test.ts`, `quickTestService.test.ts`,
  `traceContextBuilder.test.ts` (mở rộng).

## 4. Kết quả verify (thật, không suy đoán)

- Toàn bộ `tests/unit/ide`: **505 pass | 8 skip (52 file), 0 fail** (cache Vite sạch).
- Coverage quicktest: buffer **100%**, tracer **97.7%**, service **97%**, native **96%**,
  builder **92%**, bridge **88%** (phần hở còn lại = catch phòng thủ trong bridge, không
  reach được vì tracer tự nuốt lỗi nội bộ).
- oxlint 5 file source + 6 file test: **0 warning / 0 error**.
- `getDiagnostics` (tsc) tất cả file quicktest: sạch.

## 5. Kiến trúc feature (chốt sau phiên)

```
QuickTestPanel.tsx (UI, mode 'quicktest', activity-bar Bug icon)
  → ideClient.qtStart/qtStop/onQtEvent   (kênh ide.qt-start/-stop/-event)
    → quickTestBridge.registerQuickTestBridge (push-stream significant qua onEvent)
        ├─ web    : quickTestTracer (CDP attach WebContents focused tab)
        └─ native : quickTestNativeTracer (android adb logcat / windows stdio)
      → quickTestBuffer (smart-eviction dùng chung)
      → traceContextBuilder (trace → ContextPack: suspected files)
    ← bootstrap process/bridge/index.ts (getWebContents = focused WebContents)
  Agent plane: quickTestService.runSession (one-shot, dùng cùng tracer + buffer + builder)
```
