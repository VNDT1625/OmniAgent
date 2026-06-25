# Requirements — Agent Company Pipeline (làm việc THẬT, đệ quy theo rule)

## Giới thiệu

Tính năng này nâng **Mô hình công ty tác nhân** (Yêu cầu 3 của OmniAgent) từ mức "các tác nhân nói
chuyện 1 cấp + sếp duyệt" lên **một công ty làm việc thật, đệ quy nhiều cấp, điều khiển bởi rule/soul**.

Bản chất (theo người dùng): **cấp trên chỉ nói chuyện với cấp dưới trực tiếp của mình (dưới 1 cấp)** —
A nói B; B tự nói C, D; rồi gom kết quả ngược lên. Workflow KHÔNG hardcode trong code: khi AI dựng cấu
trúc vai trò, nó **đính kèm workflow vào `soul`/`rule` của từng vai** (Chủ tịch làm gì, gọi ai; Architect
làm gì, khi nào đọc codebase…). Engine chỉ cung cấp **một cơ chế đệ quy tổng quát**: mỗi agent đọc soul
của mình → tự quyết gọi cấp-dưới-trực-tiếp nào, giao việc gì → nhận lại kết quả → tổng hợp → trả lên trên.
Nhờ vậy mỗi công ty (IT, marketing, nghiên cứu…) có workflow riêng chỉ bằng soul khác nhau.

**Tác nhân thực thi tasks là LÀM THẬT (B):** mỗi vai được gán một **CLI agent / assistant thật** (Claude
Code…) chạy trong một conversation có **workspace thật** — đọc/ghi file, chạy lệnh, code thật — KHÔNG chỉ
sinh văn bản mô tả. Engine điều khiển agent này theo chương trình: gửi briefing (`conversation.sendMessage`)
→ chờ `turn.completed` → đọc `last_message.content` làm kết quả.

**Test dùng chức năng Test sẵn có của app:** khi một vai (theo rule của nó) cần kiểm thử, engine gọi
`testOrchestrator.run(scenario)` (Yêu cầu 2b) và đưa báo cáo .md trở lại luồng.

Ví dụ luồng người dùng đưa ra (công ty "IT"): Chủ tịch → Architect (lead thu thập dữ liệu: có codebase
thì tác nhân-đọc-code → báo cáo → bàn tác nhân-2; chưa có thì bàn thẳng → ra C4 + report) → Chủ tịch duyệt
→ chia task Backend & Frontend → 2 lead chia nhỏ cho tác nhân → tác nhân xong → qua Test → OK → trả lead →
lead gom → Chủ tịch duyệt cuối → trả user. Đây chỉ là **một** công ty ví dụ; engine phải tổng quát cho mọi
công ty.

### Nền tảng đã có (tái dùng, không làm lại)

- `companyOrchestrator.createStructure` — dựng cây vai trò đủ cấp (Chủ tịch → head → worker). ✅
- `memoryStore` (soul.md/memory.md, atomic, mỗi agent một thư mục). ✅
- `companyConfig` (rule công ty, `createFromDescription` dựng sơ đồ vai từ mô tả). ✅
- `companyConversation` (engine chat 1 cấp + cổng phê duyệt + bảng trạng thái + Manager popup) — **sẽ
  được nâng thành đệ quy + thực thi thật**. ✅ (một phần)
- Conversation thật: `conversation.sendMessage` + sự kiện `turn.completed` (`state:'finished'`,
  `can_send_message`, `last_message.content`, `workspace`) — primitive để chạy CLI agent theo chương trình. ✅
- `testOrchestrator.run(scenario)` + Testing MCP — chạy test thật, ra báo cáo .md. ✅
- Gán executor cho vai (CLI/assistant/draft) + `acceptDrafts` — đã có ở Company UI. ✅
- `ResourceCoordinator.requestLease({kind:'agent'})` — giới hạn song song. ✅

### Khoảng cách phải lấp (phạm vi spec này)

1. Giao việc **đệ quy theo cây** (A→B→C/D), thay vì flatten/1-cấp.
2. **Thực thi thật**: mỗi vai chạy CLI agent thật trong workspace, engine await kết quả.
3. **Workflow do rule/soul lái** (AI nhồi workflow vào soul khi tạo công ty; engine đọc soul để quyết).
4. **Cổng duyệt theo giai đoạn** (Chủ tịch duyệt tài liệu trước khi chia task; duyệt cuối trước khi trả user).
5. **Vòng Test** nối `testOrchestrator`.
6. **Concurrency**: khi một lead bận xử lý cấp dưới này mà cấp dưới khác trả về, vẫn xử lý được (hàng đợi/
   spawn phụ), gated bởi ResourceCoordinator.
7. **Quan sát**: Manager popup hiện cây đệ quy, ai-nói-với-ai, artifact/báo cáo, cổng duyệt.

## Yêu cầu

### Yêu cầu 1 — Workflow do rule/soul điều khiển (không hardcode)

**Câu chuyện:** Là người dùng, tôi muốn workflow của công ty nằm trong rule/soul của từng vai do AI sinh
ra lúc tạo công ty, để mỗi loại công ty có cách vận hành riêng mà không phải sửa code.

#### Tiêu chí chấp nhận

1. KHI AI dựng cấu trúc vai trò từ mô tả (`createFromDescription`), THÌ hệ thống PHẢI sinh cho **mỗi vai**
   một `soul` chứa: vai trò, trách nhiệm, **và workflow** (khi nhận việc thì làm gì, gọi cấp-dưới-trực-tiếp
   nào với nội dung gì, khi nào yêu cầu duyệt, khi nào gọi test, trả kết quả cho ai).
2. KHI engine chạy một vai, THÌ nó PHẢI nạp `soul` + `memory` của vai đó + rule công ty vào ngữ cảnh trước
   khi vai đó hành động.
3. Soul PHẢI nêu rõ **danh sách cấp-dưới-trực-tiếp** (tên + trách nhiệm) để vai biết có thể giao cho ai.
4. KHI người dùng sửa soul/rule một vai, THÌ lần chạy kế tiếp PHẢI dùng nội dung mới (không cache cũ).
5. Hệ thống KHÔNG được hardcode quy trình của riêng một loại công ty trong code engine; mọi quy trình đặc
   thù PHẢI biểu đạt qua soul/rule.

### Yêu cầu 2 — Giao việc đệ quy theo cây (cấp trên chỉ nói cấp dưới trực tiếp)

**Câu chuyện:** Là người dùng, tôi muốn cấp trên giao việc cho cấp dưới trực tiếp, và cấp dưới đó lại giao
tiếp cho cấp dưới của nó, đệ quy, đúng như một công ty thật.

#### Tiêu chí chấp nhận

1. KHI một vai có cấp dưới trực tiếp và soul yêu cầu giao việc, THÌ engine PHẢI để vai đó tạo directive
   cho **chỉ các con trực tiếp** của nó (không nhảy cóc xuống cháu).
2. KHI một con trực tiếp lại có con của nó, THÌ con đó PHẢI dùng **đúng cơ chế đệ quy** để giao tiếp xuống —
   không giới hạn số cấp.
3. KHI tất cả con của một vai trả kết quả, THÌ vai đó PHẢI **tổng hợp** rồi trả kết quả lên cấp trên đã gọi
   nó (gom ngược lên tới Chủ tịch).
4. Engine PHẢI chống đệ quy vô hạn: giới hạn độ sâu/độ rộng hợp lý và phát hiện chu trình trong cây vai.
5. KHI một nhánh lỗi (vai con thất bại), THÌ vai cha PHẢI nhận được thông tin lỗi và xử lý theo soul (thử
   lại/giao vai khác/báo lên), không làm sập cả phiên.

### Yêu cầu 3 — Tác nhân thực thi tasks THẬT (qua CLI/assistant gán cho vai)

**Câu chuyện:** Là người dùng, tôi muốn tác nhân thực sự đọc codebase và viết code/tài liệu ra file, không
chỉ mô tả bằng lời.

#### Tiêu chí chấp nhận

1. KHI một vai được gán một **CLI agent / assistant**, THÌ engine PHẢI thực thi việc của vai đó bằng cách
   tạo/định vị một conversation thật với executor đó, gửi briefing, và **chờ** đến khi turn hoàn tất.
2. Engine PHẢI lấy kết quả từ `turn.completed` (`last_message.content`) làm output của vai để chuyển lên/xuống.
3. Tác nhân thực thi PHẢI chạy trong **workspace thật** để đọc/ghi file (codebase, tài liệu, code) — kết quả
   là file thật trên đĩa, không chỉ chữ trong chat.
4. NẾU một vai **chưa được gán** executor chạy được, THÌ engine PHẢI degrade an toàn: hoặc đề xuất draft
   assistant (cơ chế sẵn có), hoặc chạy bằng model-chat chỉ-mô-tả và **đánh dấu rõ** "chưa thực thi thật".
5. Mỗi lượt thực thi nặng PHẢI qua `ResourceCoordinator.requestLease({kind:'agent'})` và release sau khi xong.
6. Engine PHẢI có **timeout/huỷ** cho một lượt thực thi để một CLI agent treo không khoá cả phiên.

### Yêu cầu 4 — Cổng phê duyệt theo giai đoạn (quyền của sếp)

**Câu chuyện:** Là người dùng (hoặc Chủ tịch), tôi muốn duyệt ở các mốc quan trọng: duyệt tài liệu kiến
trúc trước khi chia task, và duyệt cuối trước khi trả về user.

#### Tiêu chí chấp nhận

1. KHI soul của một vai yêu cầu "trình cấp trên duyệt", THÌ engine PHẢI **tạm dừng** nhánh đó và phát một
   yêu cầu duyệt kèm **artifact** (tài liệu/kết quả) để người duyệt xem.
2. Người duyệt (Chủ tịch agent, hoặc người dùng thay Chủ tịch) PHẢI **Đồng ý / Từ chối kèm góp ý**; chỉ khi
   Đồng ý thì nhánh mới đi tiếp.
3. KHI bị Từ chối kèm góp ý, THÌ vai bị từ chối PHẢI nhận góp ý và làm lại (theo soul), không bỏ qua.
4. Hệ thống PHẢI hỗ trợ cổng duyệt **cấp quyền** (như đã có): khi vai xin làm việc nhạy cảm thì chờ duyệt.
5. Mọi quyết định duyệt PHẢI hiển thị trong dòng thời gian/transcript.

### Yêu cầu 5 — Vòng kiểm thử dùng chức năng Test sẵn có

**Câu chuyện:** Là người dùng, tôi muốn kết quả của tác nhân được kiểm thử tự động trước khi báo "xong".

#### Tiêu chí chấp nhận

1. KHI soul của một vai (vd tester, hoặc rule "phải test") yêu cầu kiểm thử, THÌ engine PHẢI gọi
   `testOrchestrator.run(scenario)` với kịch bản phù hợp và **chờ** báo cáo.
2. KHI test **đạt**, THÌ kết quả mới được trả ngược lên lead; KHI **hỏng**, THÌ vai thực thi PHẢI nhận báo
   cáo lỗi và sửa (theo soul), lặp đến khi đạt hoặc đạt giới hạn vòng.
3. Báo cáo test (.md) PHẢI được đính vào artifact của phiên để xem trong Manager popup.
4. Tác vụ test PHẢI tôn trọng lease/hàng đợi của ResourceCoordinator (như Yêu cầu 2b đã định).

### Yêu cầu 6 — Đồng thời (concurrency) khi cấp dưới trả về lúc lead đang bận

**Câu chuyện:** Là người dùng, tôi muốn khi nhiều tác nhân xong gần như cùng lúc trong khi lead đang xử lý
một tác nhân khác, hệ thống vẫn xử lý hết, không bỏ sót, không sập.

#### Tiêu chí chấp nhận

1. KHI nhiều con của cùng một lead hoàn tất trong khi lead đang xử lý một con khác, THÌ các kết quả đến sau
   PHẢI được **xếp hàng** và lead xử lý tuần tự, KHÔNG mất kết quả nào.
2. Mức song song giữa các nhánh độc lập PHẢI do `ResourceCoordinator` quyết (lease), không cố định cứng.
3. NẾU rule/soul cho phép, một lead bận có thể được **nhân thêm một phiên xử lý phụ** (cùng model + cùng
   ngữ cảnh, có thể thêm một CLI khác) để tiêu thụ hàng đợi nhanh hơn; phiên phụ PHẢI dùng đúng soul/context
   của lead và gom kết quả vào cùng một chỗ. _(Có thể đưa vào giai đoạn sau nếu phức tạp.)_
4. Hệ thống PHẢI tránh deadlock khi A chờ B mà B (qua chuỗi) lại chờ A — phát hiện và báo lỗi nhánh.

### Yêu cầu 7 — Quan sát & điều khiển (Manager popup nâng cấp)

**Câu chuyện:** Là người dùng, tôi muốn nhìn thấy cây công ty đang chạy: ai nói với ai, ai làm gì, artifact
nào ra, và duyệt ngay tại đó.

#### Tiêu chí chấp nhận

1. Manager popup PHẢI hiển thị **cây đệ quy** (không chỉ 1 cấp): Chủ tịch → head → worker… với trạng thái
   mỗi vai (idle/thinking/delegating/executing/awaiting-approval/testing/done/failed).
2. PHẢI hiển thị **ai đang nói với ai** (cạnh giữa hai vai) và transcript theo cây.
3. PHẢI liệt kê **artifact** sinh ra (tài liệu C4, report, file code thay đổi, báo cáo test) với link mở
   được (qua Universal Editor nếu khả thi).
4. Cổng duyệt (tài liệu/cấp quyền) PHẢI thao tác được ngay trong popup; quyết định phản ánh tức thời.
5. PHẢI có nút **Dừng** an toàn (huỷ phiên, dọn lease, không để CLI agent mồ côi).
6. UI PHẢI theo `frontend-design` + Arco + UnoCSS semantic token + i18n 9 ngôn ngữ; light/dark; ≤10 children/thư mục.

### Yêu cầu 8 — An toàn, ranh giới process, không phá vỡ kiến trúc

#### Tiêu chí chấp nhận

1. KHÔNG được sửa Rust backend (aioncore). Mọi điều phối nằm ở Main process (`process/company/`), UI ở
   renderer (`pages/company/`), giao tiếp qua IPC bridge có sẵn + HTTP/WS conversation sẵn có.
2. Engine PHẢI dọn tài nguyên: huỷ phiên → release mọi lease, đóng/để lại conversation hợp lý, không treo.
3. Tác nhân thực thi chạy trong workspace của conversation; engine KHÔNG tự ý xoá dữ liệu ngoài workspace.
4. Mọi chuỗi UI qua `t('key')`; sau khi sửa locale chạy `i18n:types` + `check-i18n.js`.
5. Có test: unit/property cho engine đệ quy (gom đúng, chống chu trình, hàng đợi, lease balance) + DOM test
   cho Manager popup; chạy `bunx tsc --noEmit` sạch.

### Yêu cầu 9 — Năng lực vai trò (MCP / Skills / Super-mode / cấp quyền)

**Câu chuyện:** Là người dùng, tôi muốn mỗi vai được cấp đúng năng lực để làm việc của nó — vai mở browser
đọc tin nhắn cần Browser MCP, vai edit PowerPoint cần skill office, vai làm việc nhạy cảm cần super-mode —
và AI tự cấp lúc dựng cơ cấu, còn tôi sửa được chi tiết này.

#### Tiêu chí chấp nhận

1. `RoleAssignment` PHẢI mang `capabilities` tuỳ chọn: `{ mcpServerIds?, skills?, sessionMode? }`.
2. KHI AI dựng cơ cấu, THÌ designer PHẢI biết pool MCP/skills/modes khả dụng và gán năng lực cho vai cần
   (chỉ cấp đủ dùng; super-mode/full-access cấp dè).
3. Người dùng PHẢI sửa được năng lực của BẤT KỲ vai nào (President / head / **worker**) trong AssignmentEditor:
   chọn MCP servers, skills, và permission/super mode.
4. KHI mở chat/thực thi một vai, THÌ engine PHẢI bơm năng lực vào conversation (`selected_mcp_server_ids`,
   `preset_enabled_skills`, `session_mode`) để agent thật sự có quyền/công cụ.
5. Năng lực PHẢI persist + round-trip trong `company.json` (gồm cả per-worker), nạp phòng thủ bỏ dữ liệu rác.
6. Vai trợ lý PHẢI luôn chạy được: nếu `preset_agent_type` không phải engine thật đã cài, hệ thống PHẢI
   clamp/fallback về engine khả dụng (sửa lỗi "ACP agent requires either agent_id or backend").
7. UI hiển thị tóm tắt năng lực trên cây vai; mọi chuỗi qua i18n 9 ngôn ngữ.

## Ngoài phạm vi (lần này)

- Sửa aioncore để có route mailbox/await teammate gốc (dùng conversation.sendMessage + turn.completed thay thế).
- Đa máy/đa tiến trình phân tán (chỉ trong một app instance).
- Tự động merge code song song nhiều worker vào cùng file (Phase sau; lần này worker làm trên task/file tách biệt).
