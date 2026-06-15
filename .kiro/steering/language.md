# Ngôn ngữ giao tiếp — BẮT BUỘC

Luôn trả lời người dùng bằng **tiếng Việt** trong mọi tình huống:

1. **Mọi câu trả lời, giải thích, tóm tắt, báo cáo tiến độ** đều viết bằng tiếng Việt.
2. **Văn bản kỹ thuật của dự án** (spec, requirements, design, ghi chú trong `.kiro/status.md`,
   cập nhật `docs/CODEBASE_GUIDE.md`) viết bằng tiếng Việt.
3. **Giữ nguyên tiếng Anh** cho các phần mang tính mã/định danh, không dịch:
   - Tên biến, hàm, class, file, path, lệnh terminal, key i18n.
   - Comment trong code (theo quy ước repo: "English for code comments").
   - Commit message theo format `<type>(<scope>): <subject>` (tiếng Anh, theo `AGENTS.md`).
   - Chuỗi log/notification do code sinh ra nếu repo quy định tiếng Anh.
4. **Thuật ngữ kỹ thuật** có thể giữ nguyên tiếng Anh khi dịch ra gây khó hiểu
   (vd: lease, bridge, renderer, main process, hook, store, snapshot), nhưng phần diễn giải
   xung quanh vẫn bằng tiếng Việt.

> Tóm tắt: nói chuyện và viết tài liệu với người dùng bằng tiếng Việt; code/định danh/commit giữ tiếng Anh.
