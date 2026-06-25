# Status — Omni IDE (handoff cho agent kế tiếp)

> Cập nhật: 2026-06-09. Phạm vi phiên: feature **Quick Test Tracer**.
> File này liệt kê việc đã xong, việc CHƯA xong, và các lỗi/giới hạn để agent khác làm tiếp.

## ✅ Đã xong (không cần làm lại)

- **Quick Test Tracer — HOÀN THIỆN.** Chi tiết phiên: `docs/session/ide/quick-test-tracer-2026-06-09.md`.
  - Fix compile (refactor `quickTestBuffer` dở dang) + 7 vòng cải thiện (navigate re-inject,
    push-streaming, record-time marker parsing, transport-failure-as-error, significant-only
    streaming, contract đồng nhất hasError/recordedCount/onEvent).
  - Verify: `tests/unit/ide` **505 pass | 8 skip (52 file), 0 fail**; coverage buffer 100% /
    tracer 97.7% / service 97% / native 96% / builder 92% / bridge 88%; oxlint 0/0;
    `tsc --noEmit` toàn repo **sạch (0 lỗi)**.

## ⚠️ Giới hạn đã biết (CHỦ ĐÍCH bỏ qua — chỉ làm nếu muốn nâng thêm)

1. **`quickTestNativeStream.ts` chưa có unit test.** Đây là lớp OS-touching thật (android
   `adb logcat` reuse `toolResolver.resolveAdb`; windows spawn `.exe` đọc stdout/stderr). Logic
   parse đã được test gián tiếp qua `mapNativeLogLine` (trong `quickTestNativeTracer.test.ts`),
   nhưng việc spawn process / resolve adb thật chưa có test (cần mock `child_process`). Hành vi
   với device/emulator/exe THẬT chưa được kiểm bằng test tự động.
2. **`quickTestBridge.ts` còn ~88% coverage**: 2 khối `catch` phòng thủ (lỗi từ tracer) không
   reach được vì tracer tự nuốt lỗi nội bộ và không reject. Không đáng viết test ép lỗi.
3. **`QuickTestPanel.tsx` chưa có DOM test.** UI không đổi trong phiên này nên chưa bổ sung.
   Nếu sau này sửa UI panel → thêm `*.dom.test.tsx` theo `claude-ui-testing.md` (Vitest +
   @testing-library, KHÔNG computer-use).
4. Trace chỉ giữ tối đa `MAX_TRACE_EVENTS = 150` event (smart-eviction). Đủ cho phiên test ngắn;
   nếu cần phiên dài hơn thì tăng cap (cân nhắc RAM).

## 🚫 Lỗi cần người dùng/agent khác xử lý

- **(Không có lỗi tồn đọng thuộc Quick Test Tracer.)**
- Repo-wide tại thời điểm chốt phiên: `bunx tsc --noEmit` **0 lỗi**. (Đầu phiên từng thấy ~17 lỗi
  pre-existing ở `experience/`, `terminal/commandDoc/`, `news/MarketView`, settings
  `LiveMetricsSection` (icon `Battery`) — các lỗi này HIỆN ĐÃ HẾT, có thể do agent/đợt khác đã
  sửa. Nếu chúng quay lại do công việc đang dở của module khác thì KHÔNG thuộc Quick Test.)

## 📌 Lưu ý vận hành (đọc `docs/session/ide/memory.md` để đầy đủ)

- Nếu test fail kiểu `X is not defined` / `load is not a function` ở file không sửa → **xóa cache
  Vite** `rmdir /s /q node_modules\.vite` rồi chạy lại; không phải lỗi code.
- Phiên này CHỈ chạy `tests/unit/ide` + `tsc` toàn repo + oxlint phạm vi quicktest. CHƯA chạy toàn
  bộ `bun run test` (mọi module) hay e2e. Agent kế tiếp nên chạy full suite trước khi release.
- Không có thay đổi i18n trong phiên (không cần `i18n:types`/`check-i18n` cho phần này).
