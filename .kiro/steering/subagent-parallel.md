---
inclusion: always
---

# Quy tắc dùng Sub-agent để chạy song song — tối ưu thời gian

Mục tiêu: rút ngắn thời gian bằng cách giao các **task con độc lập** cho sub-agent chạy song song,
NHƯNG không gây hỏng do xung đột ghi file. Chỉ áp dụng ở **Autopilot mode**.

## Nguyên tắc cốt lõi

1. **Song song theo FILE, không theo ý muốn.** Hai sub-agent chỉ chạy song song khi chúng tạo/sửa
   **các file khác nhau** và không phụ thuộc kết quả của nhau. Nếu chạm cùng một file → PHẢI tuần tự.
2. **Luôn cân nhắc dùng sub-agent khi một task cha có ≥ 2 task con độc lập về file.** Gom các task
   con độc lập thành một "đợt song song"; chạy đợt đó bằng nhiều `general-task-execution` sub-agent.
3. **Dùng `context-gatherer`** một lần ở đầu mỗi epic lạ (vd hiểu Team Mode/mailbox trước khi wiring
   Company) để gom context, rồi mới chia việc.

## Khi nào song song / khi nào tuần tự

**Song song được (mỗi task con = file riêng):**

- Các service/module mới khác file: vd `memoryStore.ts`, `callTemplate.ts`, `memoryCompactor.ts`,
  `contextLayering.ts` (Task 4.2/4.4/4.3/4.7) — tạo file độc lập → giao mỗi cái cho 1 sub-agent.
- Các adapter Editor khác file (Task 8.4–8.9), các platform target (12.5), các MCP server khác file.
- Các task test `*` của các module khác nhau.

**PHẢI tuần tự (đụng file chung hoặc phụ thuộc):**

- File tổng hợp / bootstrap: `i18n-config.json`, `process/resources/builtinMcp/constants.ts`,
  đăng ký bridge ở khởi tạo Main process (Task 15.1, 15.2) — chỉ MỘT agent sửa tại một thời điểm.
- Task tích hợp gom nhiều module (orchestrator gọi các service vừa tạo): chạy SAU khi các service xong.
- Bất kỳ task nào sửa cùng file một task khác đang sửa.
- Các Checkpoint: chạy một mình, sau khi đợt song song trước đã xong và merge.

## Quy trình một "đợt song song"

1. Xác định nhóm task con độc lập về file (xem "Task Dependency Graph" / "Thứ tự chạy" trong `tasks.md`).
2. Giao mỗi task con cho một `general-task-execution` sub-agent, mô tả rõ: file được phép tạo/sửa,
   ràng buộc (Arco/UnoCSS/i18n, lease, không Node API ở renderer), và tiêu chí xong.
3. **Khóa file chung:** không giao hai sub-agent nào cùng quyền sửa một file. File chung để luồng
   chính xử lý tuần tự sau khi đợt xong.
4. Khi tất cả sub-agent trong đợt báo xong → luồng chính **gộp + chạy typecheck/test** để phát hiện
   xung đột sớm (`bunx tsc --noEmit`, test liên quan).
5. Có lỗi → theo `systematic-debugging`; sửa 2 lần không xong thì ghi `.kiro/status.md`, bỏ qua,
   tiếp đợt sau (theo rule autonomous-run).
6. Ghi vào `.kiro/status.md`: đợt nào chạy song song mấy sub-agent, kết quả.

## Giới hạn an toàn

- Tối đa khoảng **3–4 sub-agent** một đợt (tránh quá tải máy; người dùng còn dùng máy/đang ngủ máy vẫn chạy).
- Sub-agent KHÔNG được commit/push, KHÔNG xóa dữ liệu hàng loạt, KHÔNG đụng production (theo autonomous-run #5).
- Nếu nghi ngờ hai task có thể chạm cùng file mà không chắc → chọn TUẦN TỰ (an toàn hơn nhanh).
- Việc nặng trong sub-agent vẫn theo luật lease/ResourceCoordinator.

> Tóm tắt: independent-by-file → song song qua sub-agent; shared-file/integration/checkpoint → tuần tự.
> Nhanh nhưng không hỏng.
