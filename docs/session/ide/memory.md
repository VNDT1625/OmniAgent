# Memory — Omni IDE (ghi nhớ cho agent kế tiếp)

> Thông tin cần-nhớ để agent khác tiếp tục làm việc trên Omni IDE mà không phải dò lại từ đầu.
> Cập nhật gần nhất: 2026-06-09 (sau phiên hoàn thiện Quick Test Tracer).

## Quy ước/cạm bẫy quan trọng

- **Cache Vite gây lỗi giả khi chạy test.** `node_modules/.vite` thi thoảng hỏng → test ném lỗi
  như `ReferenceError: X is not defined` hoặc `TypeError: load is not a function` ở những file
  **không hề sửa** (vd `WikiPanel.dom.test.tsx`). Đây KHÔNG phải lỗi code.
  **Cách xử lý:** `rmdir /s /q node_modules\.vite` rồi chạy lại. Khi nghi test fail bất thường,
  xóa cache trước khi điều tra sâu.
- Shell = `cmd` trên Windows. Output hay bị mangle → ghi ra file `.kiro\tmp-*.txt` rồi `type | findstr`.
  Nhớ dọn file tạm sau khi xong.
- Process boundary: renderer KHÔNG dùng Node API; main KHÔNG dùng DOM API. Giao tiếp aioncore qua
  HTTP/WS; trong desktop dùng IPC bridge (`@office-ai/platform` `bridge.buildProvider/buildEmitter`).
- UI: Arco + `@icon-park/react` + UnoCSS semantic token + i18n `t('key')`. Không raw HTML, không
  hardcode màu/string.
- Mỗi thư mục ≤ 10 children.

## Quick Test Tracer — trạng thái & thiết kế (ĐÃ HOÀN THIỆN)

Vị trí: `packages/desktop/src/process/ide/quickTest*.ts` + `traceContextBuilder.ts`; UI ở
`renderer/pages/studio/ide/components/QuickTestPanel.tsx`; client `ideClient.ts` (qtStart/qtStop/onQtEvent).

Điểm cần nhớ khi đụng lại feature này:

- **`quickTestBuffer.ts` là single source of truth** cho buffer-policy + error precedence
  (`pushBounded` smart-eviction, `isErrorEvent`, `isSignificantEvent`, `findFirstError`,
  `MAX_TRACE_EVENTS = 150`). Cả web + native tracer + service đều dùng. ĐỪNG nhân bản logic này.
- **Smart-eviction**: khi buffer đầy, bỏ event ÍT giá trị nhất (log thường / 2xx) trước, giữ
  error + interaction path (click/input/navigate + failed network). Vì vậy click/input phải được
  parse thành event typed **ngay lúc record** (`parseDomMarker`), KHÔNG để tới `stop()` — nếu để
  dạng console log thì bị coi non-significant và evict mất.
- **`isErrorEvent`** tính cả transport failure: network `status >= 400` HOẶC (`status 0` + `error`).
- **Streaming là push-based** (`onEvent` dep), KHÔNG polling. Bridge chỉ stream event
  **significant** tới renderer (live feed sạch + không flood IPC); trace đầy đủ chỉ lấy lúc
  `qtStop()`. Renderer `liveEvents` chỉ là feed hiển thị, không phải nguồn kết quả.
- Cả hai tracer có contract đồng nhất: `start/stop/isActive/hasError/recordedCount/currentEvents`
  (+ native nhận thêm `platform/target` ở `start`). Service early-exit qua `hasError()` (O(1)).
- Native: web=CDP; android=`adb logcat`; windows=process stdio. Phần OS-touching ở
  `quickTestNativeStream.ts` (chưa có unit test — xem status.md).

## Lệnh hay dùng

- Test 1 nhóm: `bunx vitest run tests/unit/ide/<file>.test.ts`
- Cả module IDE: `bunx vitest run tests/unit/ide`
- Coverage: thêm `--coverage --coverage.reporter=text`
- Lint: `bunx oxlint <files>` (warning pre-existing nhiều, chỉ error mới là fail)
- Typecheck nhanh: dùng `getDiagnostics` trên file thay vì `tsc` toàn repo (tsc toàn repo còn
  nhiều lỗi pre-existing ngoài phạm vi — xem status.md).
