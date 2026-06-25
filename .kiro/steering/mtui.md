# Quy tắc dùng MTUI — BẮT BUỘC

Dự án có sẵn **MTUI** (Rust CLI ở `packages/mtui/`, binary `mtui` đã nằm trên PATH:
`~/AppData/Local/mtui/mtui.exe`). Đây là công cụ chính để **map/đọc/ghi file** hiệu quả và
**dò lỗi** trong codebase này (theo `AGENTS.md` mục "MTUI Runtime"). Luôn ưu tiên dùng MTUI khi
thao tác qua terminal.

## Khi nào BẮT BUỘC dùng MTUI

1. **Trước khi đọc file nguồn dài / mở rộng phạm vi**: chạy
   `mtui --json map intent "<mô tả task/lỗi>"` để khoanh vùng file liên quan (trả `files`,
   `recommended_path`, `read_priority`), rồi thu hẹp bằng:
   - `mtui --json map folder <path>` — bản đồ một thư mục.
   - `mtui --json context "<task>"` — gom ngữ cảnh theo task.
   - `mtui --json compass read <file> --query "<task>"` — đọc có định hướng phần liên quan.
   - `mtui --json read <file> --from <n> --to <m>` — đọc khoảng dòng cụ thể.
2. **Khi điều tra/dò lỗi**: bắt đầu bằng `map intent` mô tả triệu chứng để MTUI chỉ ra file nghi vấn
   trước khi đọc tay (vừa nhanh vừa tiết kiệm context). Kết hợp với skill `systematic-debugging`
   (root cause trước khi sửa).
3. **Mọi thao tác GHI file qua terminal** phải đi qua MTUI để có `diff`/`undo`:
   - `mtui new <file>` — tạo file mới.
   - `mtui edit <file>` / `mtui apply-patch` — sửa file.
   - `mtui diff` — xem thay đổi; `mtui undo` — hoàn tác.

   > Lưu ý: các tool ghi-file của agent (fs_write/str_replace/fs_append) vẫn được phép dùng như
   > bình thường cho luồng chỉnh sửa trong IDE. Quy tắc "ghi qua MTUI" áp dụng khi **thao tác bằng
   > lệnh terminal**, không thay thế tool IDE. Mục tiêu: đừng dùng `echo >`, `sed`, `awk`,
   > redirection thô để ghi file — dùng MTUI để có diff/undo an toàn.

## Cách gọi (shell = cmd, output hay bị mangle)

- Luôn thêm cờ `--json` để parse ổn định.
- Ghi output ra file rồi `read_file` nếu cần đọc đầy đủ (cmd hay cắt/đảo dòng):
  `mtui --json map intent "..." > .kiro\tmp-mtui.txt 2>&1` rồi đọc file.
- Dọn file tạm `.kiro\tmp-mtui*.txt` sau khi xong.

## Giới hạn / an toàn

- MTUI bổ trợ, KHÔNG thay thế các quy tắc khác (skills, i18n, frontend-design, claude-ui-testing).
- KHÔNG dùng MTUI để chạy app/test UI bằng computer-use (vẫn theo `claude-ui-testing.md`).
- Nếu `map` báo `"stale": true` thì kết quả có thể cũ — vẫn dùng để khoanh vùng, nhưng xác minh lại
  bằng đọc file thực tế trước khi kết luận.
- Nếu MTUI không khả dụng (binary lỗi) → degrade về search/read tool thường, ghi chú trong báo cáo.

> Tóm tắt: terminal đụng tới mã nguồn → `mtui --json map intent` trước để khoanh vùng + dò lỗi,
> đọc bằng `compass read`/`read`, ghi qua MTUI để có diff/undo. Nhanh, ít tốn context, an toàn.
