---
inclusion: always
---

# Quy tắc chạy tự chủ (Autonomous Run) — BẮT BUỘC

Áp dụng khi thực thi task (đặc biệt "Run all tasks") trong lúc người dùng vắng mặt.

1. **KHÔNG hỏi người dùng.** Mọi quyết định (đặt tên, vị trí file, giá trị mặc định, chọn cách
   triển khai khi spec không nói rõ) tự quyết theo phương án hợp lý nhất và bám `design.md` +
   các skill. Không dừng chờ xác nhận.

2. **Ghi lại quyết định** vào `.kiro/status.md` — mỗi quyết định một dòng ngắn (task + chọn gì + lý do).

3. **Gặp lỗi không sửa được**: thử tự sửa tối đa **2 lần** (theo `systematic-debugging`). Vẫn không
   được → **bỏ qua, không dừng cả phiên**, đánh dấu task `[-]` trong `tasks.md`, ghi vào mục
   "Lỗi cần người dùng xử lý" trong `.kiro/status.md` (task + triệu chứng + đã thử gì + nghi nguyên
   nhân), rồi **tiếp tục task kế tiếp**.

4. **Chỉ dừng hẳn** khi gặp quyết định kiến trúc lớn không thể tự quyết an toàn (vd buộc phải sửa
   Rust backend aioncore, hoặc thao tác phá hủy/không hồi phục). Khi đó ghi rõ vào status rồi dừng.

5. **Ngoại lệ an toàn** (vẫn áp dụng dù chạy tự chủ): không tự ý xóa dữ liệu hàng loạt, không đụng
   production, không commit/push trừ khi task yêu cầu rõ. Việc nặng vẫn theo luật lease/ResourceCoordinator.

6. **Cập nhật trạng thái task** ngay khi xong mỗi sub-task (`[ ]` → `[x]`) để lần chạy sau không lặp.

> File trạng thái: `.kiro/status.md`. Người dùng sẽ đọc file này khi quay lại để xem đã làm gì và
> còn lỗi nào cần fix tay.
