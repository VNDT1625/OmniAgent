# Requirements Document

> **Tính năng:** **Manager** — Personal Manager (Tasks + Note + Schedule, có AI hỗ trợ).
> **Dự án:** OmniAgent (fork của [AionUi](https://github.com/iOfficeAI/AionUi), iOfficeAI, Apache-2.0).
> **Tính năng:** **Manager** — một "ứng dụng trong ứng dụng" gồm ba phần: Nhiệm vụ (Tasks), Ghi chú (Note),
> và Lịch trình cá nhân (Schedule), có AI hỗ trợ tạo/quản lý/tối ưu.

## Introduction

Tài liệu này mô tả yêu cầu cho **Manager**, một module mới trong OmniAgent giúp một người dùng cá nhân
tổ chức công việc hằng ngày trên một màn hình duy nhất. Manager gồm ba phần chính:

1. **Tasks** — danh sách nhiệm vụ kiểu todo. Người dùng mô tả việc cần làm để AI tự bóc tách thành nhiệm vụ,
   hoặc tự tạo thủ công; AI theo dõi, sắp xếp và hệ thống nhắc nhở đúng lúc; giao diện được thiết kế theo
   nguyên tắc khoa học tâm lý để dễ tập trung và ít gây quá tải.
2. **Note** — ghi chú tự do như sổ tay thông thường, gắn (tuỳ chọn) với nhiệm vụ hoặc mốc lịch.
3. **Schedule** — lịch trình cá nhân dựng từ Tasks và các ràng buộc người dùng nhập (thủ công hoặc qua
   lời nhắc/prompt), được AI tối ưu dựa trên khoa học làm việc + thời gian + địa điểm + thời tiết + mức độ
   cần thiết.

Manager là một tính năng **độc lập** với tám nhóm yêu cầu OmniAgent đang phát triển (xem
`.kiro/specs/aionui-enhancements/`). Nó bám đúng ranh giới kiến trúc của codebase và **không yêu cầu sửa
aioncore** (xem mục Ràng buộc kiến trúc).

## Glossary

- **Nhiệm vụ (Task):** một việc cần làm, có tiêu đề, trạng thái, ưu tiên, hạn chót (tuỳ chọn), ước lượng
  thời gian (tuỳ chọn) và các nhiệm vụ con (subtask).
- **Ghi chú (Note):** một mẩu văn bản tự do (hỗ trợ Markdown), có thể gắn nhãn và liên kết tới task/sự kiện.
- **Sự kiện lịch (Event):** một khối thời gian trên lịch (bắt đầu/kết thúc, địa điểm tuỳ chọn), có thể sinh
  ra từ một task hoặc người dùng nhập trực tiếp.
- **Lịch trình (Schedule):** tập hợp các sự kiện trong một khoảng thời gian (ngày/tuần).
- **Mô tả → nhiệm vụ:** người dùng viết một đoạn mô tả việc cần làm; AI bóc tách thành danh sách task
  có cấu trúc.
- **Tối ưu lịch:** AI sắp xếp lại thứ tự/khung giờ của các sự kiện dựa trên nhiều yếu tố (khoa học, thời
  gian, địa điểm, thời tiết, mức độ cần thiết) và đề xuất phương án.
- **Nhắc nhở (Reminder):** thông báo phát ra trước/đúng mốc thời gian của task hoặc sự kiện.
- **Model người dùng:** AI provider/model mà người dùng đã cấu hình trong Settings → Model; mọi lời gọi
  AI của Manager dùng đúng model này (không cứng nhà cung cấp).

## Ràng buộc kiến trúc (kế thừa từ OmniAgent — BẮT BUỘC)

Các yêu cầu dưới đây PHẢI thoả các ràng buộc sau, giống mọi tính năng OmniAgent khác (xem
`docs/CODEBASE_GUIDE.md` và `.kiro/specs/aionui-enhancements/design.md`):

1. **Không sửa aioncore (Rust binary).** Toàn bộ logic Manager nằm ở `packages/desktop/src/process/**`
   (service Main process, Node.js) và `packages/desktop/src/renderer/**` (UI). Nếu một yêu cầu **bắt buộc**
   phải đụng backend, nó PHẢI được đánh dấu rõ và kèm phương án thay thế không-đụng-backend.
2. **Lưu trữ cục bộ bằng tệp.** Dữ liệu Manager (tasks, notes, events, cấu hình) lưu trong thư mục dữ liệu
   app dưới dạng tệp (JSON), theo tiền lệ các service Main process hiện có (vd `resource-state.json`,
   `company.json`). **Không upload lên máy chủ.**
3. **AI gọi qua model người dùng đã cấu hình** (pattern `providerChat.ts`: đọc `GET /api/providers` rồi gọi
   `/chat/completions`). Không nhúng API key cứng; khi chưa cấu hình model, các tính năng AI PHẢI báo lỗi
   thân thiện thay vì treo.
4. **Phơi năng lực hai mặt phẳng:** (a) UI qua IPC bridge trong `process/bridge/`; (b) Agent qua built-in
   MCP server stdio trong `process/resources/builtinMcp/` — cùng gọi một service Main process.
5. **UI dùng `@arco-design/web-react` + icon `@icon-park/react` + UnoCSS semantic token + i18n `t('key')`**;
   không raw HTML tương tác, không hardcode màu/chuỗi; renderer không dùng Node.js API. Mỗi thư mục ≤ 10 con.
6. **Việc nặng đi qua ResourceCoordinator** (lease) khi cần — vd lời gọi AI tối ưu lịch hàng loạt.

---

## Requirements

> **Quy ước:** Mỗi yêu cầu gồm một _User Story_ và các _tiêu chí chấp nhận_ viết dạng điều kiện
> (KHI… THÌ hệ thống PHẢI…). "Hệ thống" = module Manager của OmniAgent.

---

### Yêu cầu 1 — Quản lý nhiệm vụ thủ công (Tasks CRUD)

**User Story:** Là người dùng, tôi muốn tạo, sửa, hoàn thành và xoá nhiệm vụ thủ công như một ứng dụng todo,
để theo dõi việc cần làm.

#### Tiêu chí chấp nhận

1. Hệ thống PHẢI cho phép tạo một nhiệm vụ với tối thiểu: tiêu đề, và (tuỳ chọn) mô tả, độ ưu tiên
   (thấp/vừa/cao/khẩn), hạn chót, ước lượng thời gian, nhãn (tag).
2. Hệ thống PHẢI cho phép một nhiệm vụ có các **nhiệm vụ con** (subtask) đánh dấu hoàn thành độc lập.
3. Hệ thống PHẢI hỗ trợ **nhiều loại nhiệm vụ** để phân loại và hiển thị phù hợp, tối thiểu gồm:
   (a) **việc một lần** (one-off) — làm xong là đóng;
   (b) **việc lặp lại** (recurring) — theo chu kỳ (hằng ngày/tuần/tháng), sinh lần kế khi hoàn thành lần hiện tại;
   (c) **thói quen/đầu việc nhỏ** (habit / micro-task) — việc nhẹ, nhanh, có thể gộp nhóm để xử lý cùng lúc;
   (d) **cột mốc** (milestone) — việc lớn không có hành động trực tiếp, dùng để gom subtask.
   Mỗi loại PHẢI có biểu tượng/nhãn trực quan riêng và lọc được theo loại.
4. KHI người dùng đánh dấu một nhiệm vụ là hoàn thành, hệ thống PHẢI lưu trạng thái `done` kèm thời điểm
   hoàn thành, và phản ánh ngay trên giao diện.
5. Hệ thống PHẢI cho phép sửa và xoá nhiệm vụ; KHI xoá, hệ thống PHẢI hỏi xác nhận (tránh mất dữ liệu ngoài ý muốn).
6. Hệ thống PHẢI cho phép lọc và sắp xếp nhiệm vụ theo: trạng thái, độ ưu tiên, hạn chót, nhãn.
7. Hệ thống PHẢI lưu toàn bộ nhiệm vụ vào tệp cục bộ và khôi phục đầy đủ sau khi khởi động lại ứng dụng.
8. KHI dữ liệu nhiệm vụ trên đĩa hỏng hoặc thiếu trường, hệ thống PHẢI nạp phòng thủ (bỏ qua bản ghi lỗi,
   giữ phần còn lại) thay vì sập màn hình.

---

### Yêu cầu 2 — Tạo nhiệm vụ từ mô tả bằng AI

**User Story:** Là người dùng, tôi muốn viết một đoạn mô tả việc cần làm bằng ngôn ngữ tự nhiên, để AI tự
bóc tách thành danh sách nhiệm vụ có cấu trúc.

#### Tiêu chí chấp nhận

1. Hệ thống PHẢI cung cấp ô nhập mô tả; KHI người dùng gửi mô tả, hệ thống PHẢI gọi model người dùng đã
   cấu hình để sinh ra danh sách nhiệm vụ đề xuất (tiêu đề, ưu tiên, subtask, ước lượng thời gian, hạn chót
   nếu suy ra được).
2. KHI AI trả về danh sách đề xuất, hệ thống PHẢI hiển thị cho người dùng **xem trước và chỉnh sửa** trước
   khi lưu (không tự ý ghi đè dữ liệu).
3. Người dùng PHẢI có thể chấp nhận toàn bộ, chấp nhận một phần, hoặc huỷ danh sách đề xuất.
4. KHI chưa cấu hình model AI, hệ thống PHẢI hiển thị thông báo hướng dẫn cấu hình thay vì lỗi kỹ thuật/treo.
5. KHI lời gọi AI thất bại hoặc trả định dạng sai, hệ thống PHẢI báo lỗi thân thiện và cho phép thử lại,
   đồng thời giữ nguyên mô tả người dùng đã nhập.
6. Lời gọi AI bóc tách nhiệm vụ PHẢI đi qua ResourceCoordinator (lease) để không gây quá tải khi chạy cùng
   các tác vụ nặng khác.

---

### Yêu cầu 3 — AI quản lý nhiệm vụ và hệ thống nhắc nhở

**User Story:** Là người dùng, tôi muốn AI giúp theo dõi và sắp xếp nhiệm vụ, đồng thời được nhắc đúng lúc,
để không bỏ lỡ việc quan trọng.

#### Tiêu chí chấp nhận

1. Hệ thống PHẢI cho phép đặt nhắc nhở cho một nhiệm vụ (theo mốc thời gian tuyệt đối hoặc tương đối trước
   hạn chót).
2. KHI tới thời điểm nhắc, hệ thống PHẢI phát thông báo hệ thống (dùng cơ chế notification có sẵn) với tiêu
   đề và nội dung nhiệm vụ; KHI người dùng tắt thông báo trong Settings, hệ thống PHẢI tôn trọng lựa chọn đó.
3. Hệ thống PHẢI có cơ chế nhắc lại ở lần khởi động kế tiếp nếu một nhắc nhở đã quá hạn mà ứng dụng không
   chạy lúc đó (không "nuốt" nhắc nhở quá hạn).
4. Hệ thống PHẢI cung cấp một thao tác "AI rà soát nhiệm vụ" để: phát hiện nhiệm vụ quá hạn/sắp tới hạn,
   đề xuất độ ưu tiên, gợi ý gộp/tách, và đề xuất thứ tự thực hiện trong ngày.
5. KHI AI đề xuất thay đổi (ưu tiên, thứ tự, gộp/tách), hệ thống PHẢI hiển thị đề xuất để người dùng duyệt;
   không tự động thay đổi dữ liệu nhiệm vụ nếu người dùng chưa chấp nhận.
6. Hệ thống PHẢI cho phép người dùng tạm hoãn (snooze) hoặc tắt một nhắc nhở.

---

### Yêu cầu 4 — Giao diện Tasks theo khoa học tâm lý

**User Story:** Là người dùng, tôi muốn giao diện nhiệm vụ đẹp, gọn và dễ tập trung, để không bị quá tải và
duy trì động lực.

#### Tiêu chí chấp nhận

1. Giao diện PHẢI ưu tiên hiển thị "việc hôm nay / việc tiếp theo" nổi bật, giảm nhiễu thị giác từ danh sách
   dài (vd nhóm theo ngày, thu gọn việc đã xong).
2. Giao diện PHẢI dùng tín hiệu trực quan nhất quán cho độ ưu tiên và trạng thái (màu semantic token, không
   hardcode), phân biệt rõ nhưng không chói/gây căng thẳng.
3. KHI người dùng hoàn thành một nhiệm vụ, hệ thống PHẢI cung cấp phản hồi tích cực nhẹ nhàng (vd hiệu ứng
   tinh tế / cập nhật tiến độ), tôn trọng `prefers-reduced-motion`.
4. Giao diện PHẢI hiển thị tiến độ trong ngày (vd số việc xong/tổng) để tạo cảm giác hoàn thành.
5. Giao diện PHẢI hoạt động đúng ở cả light và dark theme, và toàn bộ chuỗi hiển thị qua i18n (mặc định hỗ
   trợ tiếng Việt, có fallback tiếng Anh).
6. Giao diện PHẢI render bằng `@arco-design/web-react` + `@icon-park/react` + UnoCSS (không raw HTML tương
   tác, không Tailwind/shadcn).

---

### Yêu cầu 5 — Ghi chú (Note): ba loại Daily / Learn / Data

**User Story:** Là người dùng, tôi muốn phần ghi chú chia thành ba loại — nhật ký thường ngày, ghi chú học
tập kiểu Obsidian có nghiên cứu web bằng AI, và thư viện tài liệu được quản lý thông minh — để mỗi mục đích
có một không gian riêng phù hợp.

#### Tiêu chí chấp nhận chung

1. Hệ thống PHẢI phân ghi chú thành ba loại: **`daily`** (nhật ký/ghi chú thường ngày), **`learn`** (ghi
   chú học tập), **`data`** (tài liệu học tập). Giao diện Note PHẢI có ba mục con tương ứng để chuyển qua lại.
2. Mọi ghi chú PHẢI hỗ trợ tiêu đề (tuỳ chọn), nội dung Markdown, nhãn (tag), và tìm kiếm/lọc theo từ khoá + nhãn.
3. Hệ thống PHẢI cho phép (tuỳ chọn) liên kết một ghi chú với một nhiệm vụ hoặc một sự kiện lịch, và chuyển
   một ghi chú thành nhiệm vụ.
4. Hệ thống PHẢI lưu mọi ghi chú vào tệp cục bộ và khôi phục sau khởi động lại; nạp phòng thủ khi dữ liệu hỏng.
5. Giao diện Note PHẢI tuân thủ cùng ràng buộc UI (Arco + UnoCSS + i18n, light/dark) như phần Tasks.

#### Daily — nhật ký / ghi chú thường ngày

6. Mục Daily PHẢI nhóm ghi chú theo ngày (mới nhất trước) và cho phép tạo nhanh một mục cho "hôm nay".
7. Mỗi ghi chú daily PHẢI gắn một ngày tham chiếu (mặc định ngày tạo, sửa được).

#### Learn — ghi chú học tập kiểu Obsidian + nghiên cứu web bằng AI

8. Mục Learn PHẢI hỗ trợ **liên kết hai chiều giữa các ghi chú** theo cú pháp `[[Tiêu đề]]`: hiển thị
   được danh sách **liên kết đi** và **backlink** (ghi chú nào trỏ tới ghi chú hiện tại).
9. Mục Learn PHẢI cung cấp thao tác **"Nghiên cứu bằng AI"**: KHI người dùng nhập một chủ đề/câu hỏi, hệ
   thống PHẢI **tìm kiếm web**, tổng hợp kết quả bằng model người dùng thành một ghi chú học tập có cấu trúc
   (tóm tắt + ý chính + **danh sách nguồn kèm liên kết**), và hiển thị **xem trước cho người dùng chỉnh sửa**
   trước khi lưu (không tự ý ghi).
10. KHI tìm web thất bại, offline, hoặc không có model, hệ thống PHẢI báo thân thiện và vẫn cho phép soạn
    ghi chú thủ công; KHI có một phần kết quả, hệ thống PHẢI dùng phần có được và nêu rõ giới hạn.
11. Tìm kiếm web PHẢI dùng nguồn không bắt buộc khoá API (mặc định), chạy ở Main process (tránh CORS), và
    lời gọi AI tổng hợp PHẢI đi qua ResourceCoordinator (lease).

#### Data — thư viện tài liệu học tập, quản lý thông minh

12. Mục Data PHẢI cho phép thêm mục tài liệu gồm: tiêu đề, đường dẫn tệp cục bộ hoặc URL, mô tả, nhãn.
13. Hệ thống PHẢI cung cấp thao tác AI **tóm tắt + đề xuất nhãn/phân loại** cho một mục tài liệu (để "quản
    lý thông minh"), hiển thị đề xuất để người dùng duyệt trước khi áp dụng.
14. Mục Data PHẢI cho phép tìm kiếm/lọc theo từ khoá, nhãn, và loại nguồn (tệp/URL), và mở nhanh tệp/URL gốc.

---

### Yêu cầu 6 — Lịch trình cá nhân: nhập thủ công, qua prompt và từ ảnh

**User Story:** Là người dùng, tôi muốn xếp lịch các sự kiện trong ngày/tuần, nhập bằng tay, bằng một câu
mô tả, hoặc bằng cách chụp ảnh một lịch có sẵn (vd thời khoá biểu nhà trường), dựa trên nhiệm vụ của tôi.

#### Tiêu chí chấp nhận

1. Hệ thống PHẢI hiển thị lịch theo ngày và theo tuần, với các sự kiện có khung giờ bắt đầu/kết thúc.
2. Hệ thống PHẢI cho phép tạo/sửa/xoá sự kiện thủ công với: tiêu đề, thời gian bắt đầu/kết thúc, địa điểm
   (tuỳ chọn), nhiệm vụ liên kết (tuỳ chọn), ghi chú (tuỳ chọn), và **loại lịch** (cứng/tự do — xem Yêu cầu 7).
3. Hệ thống PHẢI cho phép tạo sự kiện trực tiếp từ một nhiệm vụ (đưa task lên một khung giờ trong lịch).
4. KHI người dùng nhập một lời mô tả lịch bằng ngôn ngữ tự nhiên (vd "họp 9h sáng mai, gym chiều thứ Ba"),
   hệ thống PHẢI gọi model người dùng để sinh ra các sự kiện đề xuất và hiển thị xem trước trước khi lưu.
5. KHI người dùng **đính kèm một ảnh** chứa lịch (vd ảnh chụp thời khoá biểu, lịch học, lịch họp), hệ thống
   PHẢI gửi ảnh cho model người dùng (đa phương thức/vision) để **đọc hiểu và bóc tách thành các sự kiện**
   (môn/tiêu đề, thứ/ngày, giờ bắt đầu–kết thúc, địa điểm nếu có), rồi hiển thị **xem trước cho người dùng
   chỉnh sửa** trước khi lưu vào lịch.
6. KHI ảnh được bóc tách thành thời khoá biểu lặp theo tuần (vd tiết học cố định), hệ thống PHẢI cho phép
   người dùng chọn áp dụng dưới dạng **sự kiện lặp lại** và đánh dấu là **lịch cứng** (mặc định đề xuất, vẫn
   sửa được trước khi lưu).
7. KHI model AI chưa cấu hình, không hỗ trợ ảnh (không có năng lực vision), hoặc lời gọi thất bại, hệ thống
   PHẢI báo lỗi thân thiện và vẫn cho phép nhập thủ công; KHI model không hỗ trợ ảnh, hệ thống PHẢI nêu rõ
   cần chọn model có khả năng đọc ảnh.
8. KHI có xung đột thời gian giữa các sự kiện, hệ thống PHẢI cảnh báo người dùng.
9. Hệ thống PHẢI lưu lịch vào tệp cục bộ và khôi phục sau khởi động lại; nạp phòng thủ khi dữ liệu hỏng.

---

### Yêu cầu 7 — Hai loại lịch: cứng (cố định) và tự do

**User Story:** Là người dùng, tôi muốn phân biệt việc cố định không thể dời (giờ học, giờ làm) với việc
linh hoạt, để AI chỉ sắp xếp lại phần linh hoạt mà không đụng phần cố định.

#### Tiêu chí chấp nhận

1. Mỗi sự kiện lịch PHẢI có thuộc tính **loại lịch**: (a) **cứng** (fixed/locked) — khối thời gian cố định
   không được thay đổi; (b) **tự do** (flexible) — có thể được dời/sắp xếp lại.
2. KHI một sự kiện là **lịch cứng**, hệ thống PHẢI **khoá** thời gian của nó: thao tác tối ưu lịch bằng AI
   (Yêu cầu 8) KHÔNG được dời, rút ngắn hay xoá sự kiện cứng; AI chỉ được sắp xếp các sự kiện tự do quanh
   các khối cứng.
3. Hệ thống PHẢI hiển thị trực quan phân biệt rõ sự kiện cứng và tự do (vd kiểu viền/biểu tượng khoá), dùng
   semantic token (không hardcode màu).
4. Người dùng PHẢI có thể chuyển một sự kiện giữa cứng ↔ tự do; KHI chuyển một sự kiện thành cứng, các đề
   xuất tối ưu sau đó PHẢI tôn trọng trạng thái mới.
5. KHI người dùng vẫn muốn sửa một sự kiện cứng thủ công, hệ thống PHẢI cho phép (khoá chỉ áp dụng cho AI tự
   động, không chặn người dùng); nhưng PHẢI yêu cầu xác nhận để tránh đổi nhầm.

---

### Yêu cầu 8 — Tối ưu lịch trình bằng AI

**User Story:** Là người dùng, tôi muốn AI sắp xếp lại phần lịch tự do của tôi sao cho hợp lý quanh các khối
cố định, để làm việc hiệu quả mà vẫn cân bằng.

#### Tiêu chí chấp nhận

1. Hệ thống PHẢI cung cấp thao tác "Tối ưu lịch" cho một ngày/tuần; KHI được gọi, hệ thống PHẢI gửi cho
   model người dùng: danh sách sự kiện (kèm loại cứng/tự do) + nhiệm vụ liên quan + các yếu tố ràng buộc, và
   nhận về một phương án sắp xếp đề xuất.
2. Việc tối ưu PHẢI **giữ nguyên các sự kiện cứng** (không dời/xoá/rút ngắn) và chỉ sắp xếp lại các sự kiện
   **tự do** vào các khoảng trống.
3. Việc tối ưu PHẢI cân nhắc tối thiểu các yếu tố: (a) **khoa học làm việc** (vd ưu tiên việc khó vào lúc
   tỉnh táo, chèn nghỉ ngơi hợp lý, tránh dồn việc nặng liên tục); (b) **thời gian** (hạn chót, ước lượng
   thời lượng, khung giờ rảnh); (c) **địa điểm** (gom các việc cùng khu vực, tính thời gian di chuyển);
   (d) **thời tiết** (ưu tiên/tránh việc ngoài trời theo dự báo); (e) **mức độ cần thiết** (ưu tiên/khẩn cấp).
4. KHI cần dữ liệu thời tiết, hệ thống PHẢI lấy từ một nguồn dữ liệu thời tiết qua mạng cho địa điểm liên
   quan; KHI không có địa điểm, không có mạng, hoặc nguồn lỗi, hệ thống PHẢI bỏ qua yếu tố thời tiết một cách
   an toàn (degrade) và nêu rõ trong kết quả rằng thời tiết không được tính.
   > ⚠️ **Phụ thuộc mạng ngoài:** yếu tố thời tiết cần gọi API bên thứ ba. Nguồn và khoá API (nếu cần) sẽ
   > chốt ở `design.md`; mặc định ưu tiên nguồn không cần khoá hoặc do người dùng tự cấu hình.
5. KHI AI trả về phương án, hệ thống PHẢI hiển thị **so sánh trước/sau** và lý do tóm tắt cho từng thay đổi
   chính; người dùng PHẢI duyệt trước khi áp dụng. Hệ thống KHÔNG tự ghi đè lịch khi chưa được chấp nhận.
6. KHI người dùng áp dụng phương án, hệ thống PHẢI giữ lại bản lịch trước đó để có thể hoàn tác (undo).
7. Lời gọi AI tối ưu lịch PHẢI đi qua ResourceCoordinator (lease) và giới hạn tần suất hợp lý để tránh quá tải.
8. KHI model AI chưa cấu hình hoặc lời gọi thất bại, hệ thống PHẢI báo lỗi thân thiện và giữ nguyên lịch hiện tại.

---

### Yêu cầu 9 — Tích hợp, lưu trữ cục bộ, truy cập cho tác nhân và i18n (xuyên suốt)

**User Story:** Là người dùng và là tác nhân AI, tôi muốn Manager được tích hợp gọn vào ứng dụng, dữ liệu an
toàn cục bộ, và tác nhân cũng thao tác được, để dùng liền mạch.

#### Tiêu chí chấp nhận

1. Hệ thống PHẢI có một điểm truy cập rõ ràng trong điều hướng của ứng dụng (vd một route + mục nav) để mở
   Manager với ba phần Tasks / Note / Schedule.
2. Toàn bộ dữ liệu (tasks, notes, events, cấu hình nhắc nhở) PHẢI lưu cục bộ bằng tệp trong thư mục dữ liệu
   app; ghi tệp PHẢI an toàn (atomic) để tránh hỏng khi ghi giữa chừng.
3. Hệ thống PHẢI phơi năng lực Manager cho tác nhân qua một **built-in MCP server** (vd: liệt kê/tạo/cập
   nhật task, tạo note, tạo/đọc sự kiện lịch) để agent khác có thể tương tác.
4. Hệ thống PHẢI phơi năng lực cho UI qua **IPC bridge** trong `process/bridge/`, gọi cùng một service Main
   process với MCP.
5. Hệ thống PHẢI thêm một **module i18n** mới cho Manager với đầy đủ chuỗi cho toàn bộ ngôn ngữ được hỗ trợ
   (mặc định en-US + vi-VN đầy đủ; các ngôn ngữ còn lại có bản dịch để tránh cảnh báo thiếu key), và đăng ký
   vào `i18n-config.json`.
6. Khi service Manager (bridge) chưa được nối vào bootstrap, giao diện PHẢI hiển thị trạng thái "chưa sẵn
   sàng" thân thiện thay vì treo/sập (đồng nhất với cách Browser/Company/Resource xử lý).

---

## Phụ thuộc & rủi ro cần chốt ở design

- **Lập lịch nhắc nhở khi app đang chạy và khi đã quá hạn:** dùng scheduler/ticker trong Main process hay
  tái dùng cron của aioncore? (Cron nằm trong aioncore — nếu tái dùng phải qua HTTP API; nếu tự lập lịch
  trong Main process thì không đụng backend.) → quyết ở `design.md`.
- **Nguồn dữ liệu thời tiết** (API, có/không cần khoá, xử lý vị trí): chốt ở `design.md`. Đây là phụ thuộc
  mạng ngoài duy nhất của tính năng — cần ghi rõ và cho phép tắt.
- **Ranh giới với Team/Company Mode:** Manager là công cụ cá nhân, không bắt buộc dùng multi-agent; chỉ gọi
  model đơn để bóc tách/tối ưu. Tránh trùng lặp với cron/scheduled-tasks hiện có (đó là lập lịch chạy _tác
  vụ agent_, còn Manager quản lý _công việc cá nhân của người dùng_).
