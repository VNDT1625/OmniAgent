# Requirements — Smart Terminal (docTerminal + Smart Fix)

## Goal

Làm cho **Terminal của chính dự án** (Settings › Terminal + IDE terminal panel) thông minh lên, KHÔNG
dựa vào MTUI, theo 2 hướng người dùng yêu cầu:

- **(a) Gợi ý lệnh nhanh (docTerminal):** một kho lệnh được vector hoá + chấm điểm theo tần suất/độ
  gần đây; lệnh chạy **thành công** được tự lưu; khi user gõ một tiền tố (vd `B`) thì hệ gợi ý lệnh
  khả năng cao nhất (`bun start`) dưới dạng **ghost-text mờ**, nhấn **Tab** để chấp nhận.
- **(b) Sửa lệnh thông minh:** tích hợp Realtime Knowledge (RTK) để biết lệnh/tool lỗi thời (vd
  `gemini` đã bị thay bằng `agi`). Khi một lệnh **chạy lỗi**, terminal hiển thị thông báo gọn:
  dòng 1 = tóm tắt lỗi, dòng 2 = "`gemini` updated → `agi`" kèm link trang cập nhật, rồi đề xuất/chạy
  lệnh thay thế; nếu vẫn lỗi thì hiện lỗi cụ thể, nếu thành công thì thôi.

## Nền tảng tái dùng (bám code thật)

- **Bắt lệnh + kết quả:** `process/terminal/shellIntegration.ts` đã phát OSC 633 →
  `shellIntegrationParser.ts` (renderer) parse ra `command-line` (lệnh đã chạy), `command-end{exitCode}`
  (0 = thành công, ≠0 = lỗi), `cwd`. Đây là nguồn sự kiện để học lệnh + phát hiện lỗi.
- **Gửi/đọc I/O:** `terminalClient.write()` ghi vào pty; `onData` stream output.
- **Persist:** pattern `memoryStore` / `rtkStore` (atomic write ở userData, fs DI).
- **Vector:** `Embedder` + hashing fallback của RTK (`process/knowledge/rtkEmbedder.ts`) — tái dùng cho
  vector hoá lệnh.
- **Lệnh lỗi thời:** Realtime Knowledge (`rtkService`) — lưu remap `tool cũ → tool mới` dạng fact.

## Functional requirements

### FR1 — Command store (docTerminal)

Lưu mỗi lệnh từng chạy: `command`, `cwd`, `shell`, `count`, `firstUsedAt`, `lastUsedAt`,
`lastExitCode`, `successCount`. Persist atomic ở `<userData>/terminal/commandDoc.json`.

### FR2 — Auto-capture khi thành công

Khi `command-end.exitCode === 0`, lệnh tương ứng (`command-line` ngay trước) được **tự lưu/tăng
count**. Lệnh lỗi không tăng `successCount` (vẫn có thể ghi nhận để gợi ý nhưng điểm thấp hơn).

### FR3 — Scoring (tần suất + gần đây + khớp tiền tố)

Chấm điểm ứng viên cho một tiền tố người dùng đang gõ:
`score = prefixMatch * w1 + frequency(count) * w2 + recency(lastUsedAt) * w3 (+ vectorSim * w4)`.
Lệnh dùng nhiều + gần đây + khớp tiền tố mạnh nhất xếp đầu. Trả về top-1 cho ghost-text + top-K cho
danh sách.

### FR4 — Vector hoá lệnh

Sinh embedding cho mỗi lệnh (qua `Embedder`, fallback hashing) để gợi ý theo ngữ nghĩa khi tiền tố
không khớp lexical (vd gõ "chạy app" → `bun start`). Vector là lớp phụ; lexical prefix + freq/recency
là chính.

### FR5 — Ghost-text suggestion + Tab-accept

Trong khi user gõ ở dòng lệnh hiện tại (giữa `prompt-end` và `command-start`), hệ theo dõi buffer dòng
đang gõ, hiện gợi ý mờ phần còn lại của lệnh top-1; **Tab** ghi nốt phần còn lại vào pty; phím khác/clear
thì ẩn. Không can thiệp khi user đang ở giữa một lệnh đang chạy.

### FR6 — Phân loại phần lệnh (cho smart-fix)

Tách lệnh thành `program` (token đầu) + `args`. Dùng `program` để tra remap lỗi thời (FR7).

### FR7 — Smart fix khi lệnh lỗi

Khi `command-end.exitCode !== 0`:
- Lấy `program` của lệnh vừa lỗi, tra RTK xem có remap `program → replacement` (+ link cập nhật).
- Hiển thị notice gọn (overlay/decoration, KHÔNG ghi vào pty làm rối output): dòng 1 tóm tắt lỗi,
  dòng 2 "`<old>` updated → `<new>`" + link.
- Đề xuất chạy lại bằng lệnh thay thế (thay `program`, giữ args). **Mặc định yêu cầu xác nhận/1-click**
  (an toàn: không tự chạy thứ user không gõ); có **tuỳ chọn** bật auto-rerun.
- Nếu chạy lại vẫn lỗi → hiện lỗi cụ thể; thành công → thôi.

### FR8 — An toàn

- Không auto-thực thi lệnh thay thế khi chưa bật tuỳ chọn auto (mặc định tắt) — tránh chạy lệnh ngoài
  ý muốn user.
- Không lưu lệnh chứa secret rõ ràng (heuristic: token có `--token=`, `--password=`, `api_key=`… →
  redact phần giá trị trước khi lưu).
- Ghost-text/notice tôn trọng `prefers-reduced-motion`; render bằng Arco/UnoCSS token, i18n đầy đủ.

## Acceptance criteria

- Có spec design ánh xạ vào code thật (shell integration markers, terminal bridge, RTK).
- Phase đầu (command store + scoring) chạy được như module pure + test, không sửa aioncore.
- Ghost-text hoạt động trong TerminalView (Tab-accept), smart-fix hiển thị notice + remap từ RTK.
- i18n module mới đủ 9 locale; tsc/test/i18n sạch cho phạm vi feature.
