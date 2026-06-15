# /goal — Đạt mục tiêu tự chủ (vòng lặp tới khi tiệm cận 100%)

Nhận **một yêu cầu (goal)** rồi tự thực hiện theo vòng lặp khép kín: làm → kiểm tra → sửa →
phát triển tiếp, lặp đến khi kết quả **tiệm cận hoàn toàn (≈100%)** so với goal, hoặc **hết credit**.

## Usage

```
/goal <mô tả yêu cầu / mục tiêu cần đạt>
```

Arguments: $ARGUMENTS

- `<mô tả>` — phát biểu mục tiêu mong muốn. Có thể kèm ràng buộc, tiêu chí nghiệm thu, file/đường dẫn liên quan.
- Nếu không nêu tiêu chí nghiệm thu, agent **tự suy ra "Definition of Done"** hợp lý nhất và ghi vào `.kiro/status.md`.

---

## Nguyên tắc nền (áp dụng xuyên suốt)

- **Chạy tự chủ** theo `.kiro/steering/autonomous-run.md`: KHÔNG hỏi người dùng; mọi quyết định tự
  quyết theo phương án hợp lý nhất, ghi lại vào `.kiro/status.md`.
- **Đọc trước khi làm**: `docs/CODEBASE_GUIDE.md` + `AGENTS.md`; đầu phiên đọc
  `.claude/skills/SKILLS_GUIDE.md` để chọn skill đúng tình huống.
- **MTUI trước khi đọc/ghi mã qua terminal** (`.kiro/steering/mtui.md`): `mtui --json map intent "<task>"`
  để khoanh vùng, `compass read`/`read` để đọc, ghi qua MTUI để có `diff`/`undo`.
- **Stack bắt buộc**: UI = Arco + `@icon-park/react` + UnoCSS semantic token + i18n (`frontend-design` +
  `i18n` skill); renderer không Node API, main không DOM API.
- **Song song an toàn theo file** (`.kiro/steering/subagent-parallel.md`): task con độc lập-về-file →
  giao nhiều `general-task-execution` sub-agent (tối đa 3–4/đợt); file chung/integration/checkpoint → tuần tự.
- **KHÔNG dùng Claude/computer-use để test UI** (`.kiro/steering/claude-ui-testing.md`).
- **Trả lời người dùng bằng tiếng Việt**; code/định danh/commit/key i18n giữ tiếng Anh.

---

## QUY TRÌNH BẮT BUỘC 100% (không bỏ bước, không đảo bước)

Đây là pipeline cứng. Mỗi lần chạy `/goal` phải đi đủ các pha sau, lặp lại từ pha lỗi khi cần.

### 1. Phân tích query

- Bóc tách goal thành: mục tiêu chính, ràng buộc, phạm vi (in/out scope), tiêu chí nghiệm thu (DoD).
- Xác định loại việc (UI / logic / service / fix / refactor…) để chọn skill phù hợp.
- Ghi tóm tắt hiểu-được vào `.kiro/status.md` (mục goal hiện tại).

### 2. Lấy data

- Dùng `mtui --json map intent "<goal>"` → `map folder` / `context` / `compass read` để gom file liên quan.
- Cần thì dùng `context-gatherer` sub-agent **một lần** ở đầu epic lạ để gom ngữ cảnh.
- Web search khi cần thông tin ngoài codebase (version, API mới, tài liệu) — tuân thủ trích dẫn nguồn.

### 3. Suy luận + bổ sung dữ liệu & năng lực còn thiếu

- Suy luận khoảng trống kiến thức/dữ liệu; bổ sung bằng đọc thêm code / tài liệu / web.
- **Rà skill còn thiếu**: đối chiếu `.claude/skills/SKILLS_GUIDE.md`. Nếu tình huống cần một skill chưa kích hoạt →
  kích hoạt và báo dòng "Announce at start" của skill đó.
- Nếu thiếu công cụ/skill thật sự (không có sẵn) → ghi nhận giải pháp thay thế trong `.kiro/status.md`,
  KHÔNG dừng phiên (theo autonomous-run).

### 4. Planning

- Lập kế hoạch tasks rời rạc, có thứ tự phụ thuộc rõ ràng; mỗi task có tiêu chí "xong" kiểm chứng được.
- Bám `design.md` (nếu có spec) và quy ước kiến trúc (`architecture` skill).

### 5. Tối ưu plan cho sub-agent

- Phân loại task: **independent-by-file** (song song được) vs **shared-file/integration/checkpoint** (tuần tự).
- Gom task độc lập thành "đợt song song" (≤ 3–4 sub-agent). Khóa file chung cho luồng chính xử lý tuần tự.
- Mỗi sub-agent nhận mô tả rõ: file được phép tạo/sửa, ràng buộc (Arco/UnoCSS/i18n, không Node API ở
  renderer), và tiêu chí xong.

### 6. Thực hiện tasks

- Triển khai theo plan. Auto-fix khi sửa: `bun run lint:fix`, `bun run format`.
- Đụng renderer/locales/i18n → sau đó `bun run i18n:types` + `scripts/check-i18n.js`.

### 7. Quick test mỗi bước (sau mỗi task)

- Sau **mỗi task** xong, chạy **quick test nhanh kiểu Kiro** để xác minh tức thì:
  - Script kiểm tra nhanh (ví dụ Python/Node một-lần) cho logic vừa làm, **xóa sau khi xong** (file tạm).
  - Kèm `getDiagnostics` trên file vừa sửa + `bunx tsc --noEmit` cho phần liên quan.
- Quick test PASS → đánh dấu task `[x]` trong `tasks.md`/`.kiro/status.md`. FAIL → vào pha 9.

### 8. Test lần cuối qua quick test tracker (sau mỗi tính năng / bước lớn / quan trọng)

- Khi hoàn thành một **tính năng / bước lớn / quan trọng**, chạy lại "test tổng" qua quick test tracker:
  - Cổng chính thức của dự án: `bun run test` (Vitest) cho phần liên quan + `bunx tsc --noEmit` +
    oxlint + (nếu chạm UI/locale) `i18n:types` & `scripts/check-i18n.js`.
  - UI: viết/chạy DOM test (`*.dom.test.tsx`) thay cho computer-use.
- Ghi kết quả tracker (PASS/FAIL từng mục) vào `.kiro/status.md`.

### 9. Khi lỗi — vòng sửa lỗi bắt buộc (root-cause trước)

Kích hoạt `systematic-debugging`. Lặp đúng thứ tự:

1. **Tìm dữ liệu** lỗi (log, stack, `mtui map intent "<triệu chứng>"`, file nghi vấn).
2. **Suy luận lỗi** → xác định root cause (không vá triệu chứng).
3. **Planning fix** → kế hoạch sửa tối thiểu, không phá vỡ phần khác.
4. **Thực hiện fix**.
5. **Test lại** (quick test bước → tracker tổng).
6. **Thành công** → trả kết quả / tiếp pha sau. **Thất bại** → **quay lại bước trước** trong vòng này
   (data → suy luận → plan → fix → test) và thử cách khác.

> Giới hạn tự-sửa: thử tối đa **2 lần** cho một lỗi (autonomous-run #3). Vẫn không xong → đánh dấu task
> `[-]`, ghi "Lỗi cần người dùng xử lý" trong `.kiro/status.md` (triệu chứng + đã thử gì + nghi nguyên
> nhân), rồi **tiếp task kế tiếp** — KHÔNG dừng cả phiên.

### Điều kiện dừng vòng lặp `/goal`

Lặp 1→9 cho đến khi **một trong các điều kiện** sau đạt:

- Kết quả **tiệm cận hoàn toàn (≈100%)** goal: mọi tiêu chí DoD PASS, tracker xanh, typecheck/lint/i18n sạch.
- **Hết credit**.
- Gặp **quyết định kiến trúc lớn không thể tự quyết an toàn** (vd buộc sửa Rust backend aioncore, thao
  tác phá hủy/không hồi phục) → ghi rõ vào `.kiro/status.md` rồi dừng (autonomous-run #4).

---

## Phục hồi khi "treo" (terminal treo / lỗi server / hang)

Nếu một lệnh terminal **treo** (không phản hồi), server lỗi, hoặc tiến trình kẹt:

1. **Đóng/kill terminal hoặc tiến trình kẹt** (dùng `control_pwsh_process` action `stop`, hoặc kill
   PID cụ thể). KHÔNG kill app người dùng đang dùng (vd Claude Desktop/MCP server của IDE).
2. **Chờ ~5 phút** cho tài nguyên giải phóng (server release port, lease nhả).
3. **Tự gửi lại query để tiếp tục thay người dùng**: tiếp tục đúng pha đang dở (đọc `.kiro/status.md`
   để biết vị trí), không làm lại từ đầu.
4. Ghi sự cố treo + hành động phục hồi vào `.kiro/status.md`.
5. Nếu treo lặp lại **2 lần liên tiếp ở cùng bước** → coi như lỗi không tự xử được: đánh dấu `[-]`,
   ghi chú, bỏ qua, tiếp bước/đợt sau.

> Lưu ý kỹ thuật: tránh chạy lệnh long-running chặn luồng (dev server, watch) bằng tool đồng bộ; dùng
> `control_pwsh_process` (start/stop) cho tiến trình nền và `get_process_output` để theo dõi.

---

## Ghi trạng thái (BẮT BUỘC)

Trong suốt phiên, cập nhật `.kiro/status.md`:

- Goal hiện tại + DoD tự suy ra.
- Mỗi quyết định tự chủ: 1 dòng (task + chọn gì + lý do).
- Đợt song song: chạy mấy sub-agent, file nào, kết quả.
- Kết quả quick test / tracker từng mục.
- "Lỗi cần người dùng xử lý" nếu có.
- Sự cố treo + phục hồi.

Cập nhật task `[ ] → [x]` (hoặc `[-]`) ngay khi xong mỗi sub-task để lần chạy sau không lặp.

---

## Sau khi đạt goal

- Tóm tắt ngắn (tiếng Việt) cho người dùng: đã làm gì, test/tracker kết quả ra sao, còn lỗi `[-]` nào cần tay.
- Nếu thay đổi ảnh hưởng kiến trúc/API/route/i18n → cập nhật `docs/CODEBASE_GUIDE.md` (mục "Cập nhật")
  theo `.kiro/steering/codebase-guide.md`.
- KHÔNG commit/push trừ khi yêu cầu nêu rõ.

---

## Triển khai thực tế trong app (KHÔNG chỉ là doc)

`/goal` và `/goal-all` là **slash command thật** trong ô chat của agent tự chủ (aionrs), không phải
file md để đọc. Khi người dùng gõ `/goal <yêu cầu>`:

- Bubble vẫn hiển thị nguyên văn `/goal <yêu cầu>` người dùng gõ.
- Agent nhận `modelInput` đã được **expand thành prompt đầy đủ** (mục tiêu + toàn bộ quy trình bắt
  buộc 9 pha + điều kiện dừng + phục hồi treo + ràng buộc tự chủ/an toàn) → "hiểu ngay" và chạy luôn.

Mã liên quan:

- `packages/desktop/src/common/chat/slash/goalCommand.ts` — `parseGoalCommand` / `expandGoalCommand`
  (nguồn chân lý của nội dung prompt mở rộng; chính là pipeline trong file này, viết inline).
- `packages/desktop/src/renderer/components/chat/SendBox/index.tsx` — prop `enableGoal` + đăng ký 2
  builtin slash item để dropdown gợi ý khi gõ `/`.
- `packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx` — gọi
  `expandGoalCommand(input)` trong `executeCommand` trước `buildPlanningGuard`, và truyền `enableGoal`.
- i18n: `conversation.goalCommand.description` / `conversation.goalCommand.allDescription` (9 locale).
- Test: `tests/unit/common/chat/slash/goalCommand.test.ts`.

### `/goal-all` — biến thể toàn quyền (khó tính hơn)

```
/goal-all <mô tả yêu cầu>
```

Giống `/goal` nhưng: agent **toàn quyền tự quyết mọi thứ** để đạt **101%** so với yêu cầu (kết quả tối
thiểu ngang mục tiêu, ưu tiên vượt: chủ động bổ sung edge case, độ bền, test, tài liệu), tự đặt tiêu
chuẩn nghiệm thu nghiêm ngặt hơn, và chạy đến khi xong hoặc hết credit. Cùng quy trình bắt buộc 9 pha.

> Khi sửa nội dung quy trình, sửa ở `packages/desktop/src/common/chat/slash/goalCommand.ts` (mã chạy thật) rồi đồng bộ mô tả trong file này.

---

## Production-grade (đã nâng cấp)

### Đa platform

`/goal` + `/goal-all` hoạt động trên **cả 5 platform send box**: aionrs, acp, openclaw, nanobot, remote.
Mỗi platform expand `/goal` trong `executeCommand` (bubble giữ raw, model nhận prompt đầy đủ) và đăng
ký lệnh qua prop `enableGoal` của `<SendBox>`. openclaw/nanobot/remote còn expand cả đường
initial-message (khi mở hội thoại bằng `/goal ...` từ trang Guid).

### Auto-resume watchdog (chống treo)

Khi một goal-turn **treo** (running nhưng không có stream activity quá ngưỡng), watchdog tự: stop →
chờ cooldown → gửi lại goal gốc. Có chặn cứng để không loop vô hạn / tốn credit.

- Lõi thuần (test được): `packages/desktop/src/common/chat/slash/goalWatchdog.ts` —
  `evaluateWatchdog` + các transition (`armWatchdog`/`recordActivity`/`enterCooldown`/`markResumed`/
  `disarmWatchdog`), deterministic, không timer/I/O.
- Hook: `packages/desktop/src/renderer/hooks/chat/useGoalWatchdog.ts` — heartbeat từ
  `ipcBridge.conversation.responseStream`, ticker 15s, dùng `conversation.stop` + re-send `executeCommand`.
- Wire: `packages/desktop/src/renderer/pages/conversation/platforms/aionrs/AionrsSendBox.tsx` (platform agent tự chủ). CHỈ kích hoạt khi lệnh đang chạy là goal;
  resume KHÔNG re-arm (giữ nguyên bộ đếm để tôn trọng cap); disarm khi user gửi lệnh khác hoặc turn
  kết thúc bình thường.
- Mặc định (`DEFAULT_GOAL_WATCHDOG_CONFIG`): stall 5 phút, cooldown 5 phút, tối đa 3 lần resume.
- Thông báo: tip i18n `conversation.goalCommand.autoResumeNotice` mỗi lần tự tiếp tục;
  `conversation.goalCommand.autoResumeGiveup` khi hết lượt → tạm dừng chờ người dùng.

> Lưu ý: watchdog là cơ chế renderer-only (không đụng Rust backend). Nó xử lý "turn treo" ở mức
> hội thoại; việc agent có chạy đủ quy trình 9 pha vẫn phụ thuộc model tuân thủ prompt.

---

## Goal Mode — steering bền vững mỗi turn (không phải prompt một lần)

Gõ `/goal X` không chỉ gửi một message: nó **bật Goal Mode** cho hội thoại đó. Từ đó, **mọi turn**
(bạn gõ tiếp, hàng đợi, hay watchdog tự gửi lại) đều được **code chèn steering bắt buộc** vào đầu
message gửi tới agent — để quy trình không "rơi khỏi context" sau vài turn. Goal Mode giữ nguyên cho
tới khi gõ `/goal off` (hoặc `/goal stop`).

- Reminder mỗi turn: `packages/desktop/src/common/chat/slash/goalSteering.ts` → `GOAL_TURN_REMINDER` (ngắn gọn nhưng cứng:
  9 pha + tự chủ + an toàn + cách tắt). Khối đầy đủ: `buildGoalSteering(variant)`.
- Trạng thái: `packages/desktop/src/renderer/utils/chat/goalMode.ts` (localStorage `aionui.goal.mode.<conversation_id>`),
  `withGoalSteeringDirective(modelInput, cid)` chèn reminder mỗi turn (bỏ qua slash command, message đã
  có steering, hoặc khi mode off).
- Wire: `AionrsSendBox` — `/goal X` bật mode + expand turn đầu; turn sau chèn steering; `/goal off`
  tắt mode (intercept, không gửi turn) + disarm watchdog.

> Lưu ý trung thực: cơ chế này đảm bảo **văn bản steering luôn có mặt mỗi turn** (do code chèn,
> deterministic) — đây là mức "bắt buộc 100%" mà renderer làm được. Nó KHÔNG thể ép LLM tuân thủ 100%
> (không cơ chế text nào làm được). Muốn ép cứng cấu trúc (chặn agent "kết thúc" khi chưa qua đủ pha)
> phải gating vòng lặp tool ở Rust backend aioncore — nằm ngoài phạm vi an toàn của renderer.

---

## Hard enforcement — renderer control-loop (không đụng aioncore)

Để "ép cứng" ở mức cao nhất khả thi mà không sửa backend Rust: renderer trở thành **orchestrator**
điều khiển vòng lặp goal bằng CODE, thay vì tin agent tự lặp.

**Hợp đồng marker (bắt buộc trong steering):** agent PHẢI kết thúc MỖI lượt bằng đúng một dòng:

```
[[GOAL next=continue|done|blocked tests=pass|fail|none phase=<1-9>]]
```

**Quyết định bằng code** sau mỗi lượt `finish` (`packages/desktop/src/common/chat/slash/goalCompliance.ts`,
`packages/desktop/src/renderer/hooks/chat/useGoalRunner.ts`):

- thiếu marker → ép agent xuất lại (cap `maxCorrections`),
- `next=continue` → tự lái lượt kế (cap `maxAutoTurns`),
- `next=done` & `tests=pass` → **chấp nhận** (tắt Goal Mode, báo done) — đây là cách DUY NHẤT để kết thúc,
- `next=done` & `tests≠pass` → **từ chối**, bắt quay lại pha test/fix,
- `next=blocked` → dừng, báo người dùng.

Nếu lượt **không bao giờ finish** (treo) → nhánh stall huỷ lượt, cooldown, gửi lại goal. Tất cả có
cap cứng (mặc định maxAutoTurns=40, maxCorrections=3, stall/cooldown 5') để chi phí hữu hạn.

`useGoalRunner` chỉ wire ở aionrs (agent tự chủ). Các platform khác có Goal Mode steering mỗi turn +
`/goal off`, nhưng không auto-drive (an toàn chi phí trên agent bên thứ ba).

> Trần enforcement thật sự: renderer gate dựa trên tín hiệu agent KHAI BÁO (marker). Nếu agent cố tình
> ngụy tạo (báo tests=pass khi chưa chạy), renderer không phát hiện được. Ép cứng tuyệt đối (chặn agent
> "done" khi tool thật chưa chạy/chưa pass) đòi hỏi gating vòng lặp tool trong aioncore — ngoài phạm vi.

---

## Kiểm chứng độc lập (đóng lỗ hổng "agent tự khai báo")

Mặc định renderer gate "done" bằng marker do agent tự báo — agent vẫn có thể ngụy tạo `tests=pass`.
Để bịt: bật **kiểm chứng độc lập** — renderer tự chạy một lệnh verify trong workspace và **chỉ chấp
nhận khi exit code = 0**, không tin lời agent.

```
/goal verify <lệnh>      # ví dụ: /goal verify bunx tsc --noEmit
/goal verify off         # tắt kiểm chứng
```

- Opt-in để an toàn: chỉ chạy đúng lệnh bạn đặt (không tự chạy lệnh tùy tiện).
- Khi agent báo `next=done` mà có verify: renderer chạy lệnh (`runWorkspaceVerification` qua terminal
  bridge, timeout 5'), exit 0 → chấp nhận; khác 0 → từ chối, bơm output lỗi lại buộc agent sửa (vẫn
  trong cap `maxAutoTurns`).
- Không đặt verify → giữ hành vi cũ (accept theo marker).
- Lưu per-conversation: `packages/desktop/src/renderer/utils/chat/goalVerify.ts`; thực thi: `packages/desktop/src/renderer/utils/chat/runWorkspaceVerification.ts`;
  gate trong `useGoalRunner` (`verify?` callback).

> Đây là mức enforcement mạnh nhất ở renderer: điều kiện "done" gắn với **exit code thật** của lệnh
> verify, không phải lời tự khai của model. (Vẫn cần user đặt lệnh verify đúng cho từng goal.)
