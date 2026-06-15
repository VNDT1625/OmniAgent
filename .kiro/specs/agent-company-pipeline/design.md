# Design — Agent Company Pipeline (đệ quy, thực thi thật, rule-driven)

## Nghiên cứu nền (production multi-agent patterns 2025–2026)

Thiết kế bám các nguyên tắc đã được kiểm chứng trong sản xuất (Anthropic orchestrator-workers cookbook;
LangGraph supervisor; CrewAI hierarchical; các tổng kết "patterns that work 2026"). Nội dung được tổng
hợp/diễn giải lại cho hợp ngữ cảnh AionUi (không sao chép nguyên văn):

1. **Orchestrator-workers (Anthropic):** một điều phối viên _phân rã → giao việc → KIỂM CHỨNG → tổng hợp_.
   Điều phối viên **không tự viết code**; chỉ định tuyến và xác minh. Worker mới là người làm thật, mỗi
   worker có **cửa sổ ngữ cảnh riêng**. → Trong ta: head/President = orchestrator (không code), worker lá =
   executor (code thật qua CLI agent).
2. **"Done" + stop-condition + verifier rõ ràng** là thứ làm hệ thống đáng tin: mỗi bước có "done" xác định,
   mỗi kết quả qua **một verifier** trước khi đi tiếp. → Trong ta: cổng duyệt (YC4) + vòng test (YC5) chính
   là verifier; không có verifier thì không "done".
3. **DAG/máy trạng thái xác định để chống deadlock**; **ngữ cảnh theo từng agent (scoped), không dùng một
   khối nhớ chung** để tránh "context drift" (agent ghi đè trạng thái của nhau). → Trong ta: cây vai là DAG
   (cha→con), mỗi vai có soul/memory riêng + briefing scoped; `visited`/`depth` guard.
4. **Hàng đợi bất đồng bộ + backpressure** để một agent chậm không khoá cả pipeline. → Trong ta: hàng đợi
   kết quả con ở `pipelineStore` + lease của ResourceCoordinator làm backpressure (YC6).
5. **Workflow (đường đi định sẵn) vs Agent (tự quyết động):** hierarchical + supervisor là điểm cân bằng.
   → Trong ta: cấu trúc cây là "workflow khung", nhưng _quyết định giao gì cho ai_ là động, do soul + model
   quyết (rule-driven) — đúng tinh thần YC1.
6. **Anti-pattern "flat prompting"** (một prompt giải 10 bước) gây hallucination. → Trong ta: chia theo vai +
   theo bước, mỗi lượt một mục tiêu hẹp.

> Áp dụng cụ thể: **President/head KHÔNG thực thi code** (chỉ lập kế hoạch + giao + duyệt + tổng hợp); chỉ
> **worker lá** mới chạy CLI agent ghi file. Mỗi nhánh có "done" = qua test/duyệt. Ngữ cảnh scoped theo vai.

## Tổng quan

Tài liệu này thiết kế việc nâng công ty tác nhân thành **một tổ chức làm việc thật**, đệ quy nhiều cấp,
do **soul/rule** điều khiển. Nguyên tắc kiến trúc trùm lên mọi quyết định:

- **Không sửa aioncore.** Mọi điều phối dùng API sẵn có.
- **Một cơ chế đệ quy tổng quát** (`runRole`) — không hardcode quy trình của một loại công ty.
- **Thực thi thật (B)** qua **conversation + CLI/assistant** đã có: `conversation.sendMessage` →
  chờ `turn.completed` → đọc `last_message.content`. Tác nhân chạy trong **workspace thật**.
- **Hai engine, hai mặt phẳng quá trình:**
  - _Model-chat engine_ (Main, `companyConversation.ts`) — đã có; dùng cho luồng "nói" nhẹ/diễn tập.
  - _Execution orchestrator_ (**Renderer**, mới) — driver đệ quy điều khiển CLI agent thật, vì nó cần
    `ipcBridge.conversation` (HTTP/WS) + `getAgents`/`configService` vốn là API **renderer**. Đây là chỗ
    `companySession.openRoleChat` đã sống.

> **Vì sao orchestrator nằm ở renderer, không phải Main?** Primitive thực thi thật (`sendMessage`,
> `turn.completed`, tạo conversation từ agent metadata) đều là API renderer (gọi aioncore qua HTTP/WS, đọc
> `configService`). Đặt orchestrator ở renderer để **tái dùng nguyên trạng**, không phải bắc cầu IPC mới
> (đỡ rủi ro, đúng ranh giới process). Manager popup cũng ở renderer nên gọi trực tiếp, stream mượt.

## Kiến trúc

```
renderer/pages/company/
├── pipeline/                         ← MỚI: execution orchestrator (đệ quy, thực thi thật)
│   ├── companyPipeline.ts            ← runCompany(goal) → runRole đệ quy; hàng đợi; depth/cycle guard
│   ├── roleRunner.ts                 ← runRole(node): nạp soul → quyết delegate/execute → await → gom
│   ├── roleExecutor.ts              ← executeViaConversation(node, briefing): sendMessage + await turn.completed
│   ├── delegationPlanner.ts          ← hỏi model: với soul+goal, giao gì cho con nào (JSON directive[])
│   ├── approvalGate.ts               ← tạm dừng chờ Chủ tịch/user duyệt (artifact) — promise resolver
│   ├── testGate.ts                   ← gọi testing bridge (testOrchestrator) → chờ report → pass/fail loop
│   ├── pipelineTypes.ts              ← PipelineEvent, RoleRunState, Artifact, RunHandle…
│   └── pipelineStore.ts              ← state phiên (cây trạng thái, transcript, artifacts, pending)
├── manager/                          ← popup (đã có) — nâng cấp hiển thị cây đệ quy + artifacts
│   ├── ManagerPopup.tsx              (sửa) thêm chế độ "Pipeline" (chạy thật) cạnh "Conversation" (diễn)
│   ├── RoleTreeBoard.tsx             ← MỚI: cây đệ quy trạng thái + ai-nói-với-ai
│   ├── ArtifactList.tsx              ← MỚI: tài liệu/report/test report (mở qua Universal Editor)
│   ├── StatusBoard.tsx / ConversationTranscript.tsx / PermissionPanel.tsx  (đã có, tái dùng)
├── useCompanyPipeline.ts             ← MỚI: hook nối pipelineStore → React; start/approve/stop
└── companySession.ts                 ← (đã có) tái dùng buildParamsForRole/briefing

process/company/
├── companyConfig.ts                  (sửa) buildRoleChartPrompt: thêm phần SINH WORKFLOW vào soul mỗi vai
├── soulTemplates.ts                  ← MỚI (Main): hàm thuần dựng soul mặc định theo role khi AI thiếu
└── companyConversation.ts            (giữ) engine model-chat 1-cấp — không phải đường thực thi thật
```

### Vì sao tách "diễn" (conversation) và "làm thật" (pipeline)

- `companyConversation` (Main, đã có) = nhanh, rẻ, để xem luồng nói chuyện — KHÔNG đụng file.
- `companyPipeline` (renderer, mới) = chạy CLI agent thật trong workspace — ra code/tài liệu/test thật.
- Manager popup cho chọn chế độ; mặc định **Pipeline** cho công ty đã gán executor, fallback **Conversation**
  khi vai chưa gán (đúng YC3.4).

## Thành phần & giao diện

### 1. Soul mang workflow (YC1)

`companyConfig.buildRoleChartPrompt` được mở rộng: yêu cầu model trả, cho **mỗi vai**, một trường
`soul` (markdown) gồm: danh tính, trách nhiệm, **WORKFLOW** (nhận việc từ ai → làm gì → giao
cấp-dưới-trực-tiếp nào với nội dung gì → khi nào trình duyệt → khi nào gọi test → trả kết quả cho ai).
Soul được lưu qua `memoryStore.writeSoul(agentId, soul)` khi tạo công ty (và khi user sửa).

`soulTemplates.ts` (thuần, Main) sinh soul mặc định an toàn nếu model bỏ trống — ví dụ:

- President: "Nhận goal từ user. Giao cho từng head theo trách nhiệm. Nhận lại kết quả, trình bày cho user.
  Trình duyệt các mốc lớn."
- Division-head: "Nhận directive từ cấp trên. Chia nhỏ cho worker của mình. Gom kết quả, báo cáo lên."
- Worker: "Nhận task. Thực thi trong workspace. Báo kết quả + đường dẫn file đã đổi."

> Engine KHÔNG đọc hiểu workflow để "chạy đúng kịch bản"; nó chỉ **đưa soul vào prompt** rồi để model tự
> quyết hành động qua giao thức ở mục 3. Quy trình đặc thù do soul quyết (YC1.5).

### 2. Cơ chế đệ quy `runRole` (YC2)

`roleRunner.runRole(node, incoming)`:

1. Nạp `soul` + `memory` (memoryStore) + rule công ty + **danh sách con trực tiếp** (tên, trách nhiệm).
2. **Phân vai theo nguyên tắc orchestrator-workers:**
   - **Vai có con (President/division-head) = ORCHESTRATOR → KHÔNG tự viết code.** Chỉ được `delegate` /
     `request_approval` / `request_test` / `finish(tổng hợp)`. Nếu model cố `execute`, ép quay lại `delegate`
     (trừ khi nó là việc không-code như viết tài liệu kế hoạch — vẫn cho execute model-chat, đánh dấu doc).
   - **Vai lá (worker) = EXECUTOR → làm thật** qua CLI agent (mục 4). Lá không `delegate`.
3. Hỏi model (`delegationPlanner`) với soul + `incoming`: trả JSON một trong các mode (mục bên dưới). Với
   orchestrator, chỉ chấp nhận `delegate/request_approval/request_test/finish`.
4. **delegate** → mỗi directive (chỉ tới **con trực tiếp**) gọi đệ quy `runRole(child, {task, fromId})`. Các
   nhánh chạy song song nhưng **gated bởi lease** (mục 6). Con của con dùng **đúng `runRole`** → đệ quy không
   giới hạn cấp (YC2.2).
5. Khi mọi con xong → vai này **tổng hợp** (một lượt model: gom report các con) → **verifier gate**: nếu soul
   yêu cầu, qua `request_approval` và/hoặc `request_test` trước khi coi là "done" → trả kết quả lên cấp gọi
   (YC2.3). "Done" chỉ hợp lệ khi đã qua verifier áp dụng (nguyên tắc 2 của nghiên cứu).
6. **Guard:** `depth ≤ MAX_DEPTH` (vd 6) + tập `visited` theo nodeId phát hiện chu trình (YC2.4). Lỗi nhánh
   → trả `{ok:false, error}` lên cha; cha xử theo soul (YC2.5), không reject cả phiên.

Giao thức directive (JSON fenced, provider-agnostic — như webAgentRunner):

```json
{"mode":"delegate","directives":[{"childId":"co:head:backend","task":"..."}]}
{"mode":"execute","task":"..."}
{"mode":"request_approval","artifact":"...","summary":"..."}
{"mode":"request_test","scenario":{...}}
{"mode":"finish","result":"..."}
```

`delegationPlanner` parse khối này; chỉ chấp nhận `childId` là **con trực tiếp** của node (chặn nhảy cóc).

### 3. Thực thi thật `roleExecutor` (YC3)

`executeViaConversation(node, briefing)`:

1. Resolve executor của vai từ `node.assignment` (tái dùng `companySession.buildParamsForRole`): CLI hay
   assistant. Có **workspace thật** (mặc định workspace công ty/ phiên).
2. Tạo/định vị conversation (`ipcBridge.conversation.create` qua params; nhớ map role→convId như
   `companySession` đã làm). Inject briefing (company+division+rule+soul) như rules layer.
3. `ipcBridge.conversation.sendMessage({conversation_id, input: task})`.
4. **Chờ** `ipcBridge.conversation.turnCompleted.on(...)` cho đúng `session_id` tới khi `state==='finished'`
   && `can_send_message`; lấy `last_message.content` làm kết quả. Có **timeout** (vd 10 phút, cấu hình) +
   huỷ (YC3.6). Bóc lease `agent` quanh lượt (YC3.5).
5. Trả `{result, workspace, changedFiles?}`. (changedFiles: nếu agent liệt kê; không thì để trống.)
6. **Fallback (YC3.4):** vai chưa gán executor chạy được → hoặc đề xuất draft (cơ chế `acceptDrafts` đã có),
   hoặc chạy `companyConversation` model-chat và đánh dấu `simulated:true` trong artifact.

> Tái dùng tối đa: tạo params, briefing, map convId đều đã có trong `companySession.ts`. roleExecutor chỉ
> thêm phần **gửi + chờ turn + timeout** (chưa có).

### 4. Cổng duyệt theo giai đoạn (YC4)

`approvalGate`: khi planner trả `request_approval`, pipeline emit `PipelineEvent{type:'approval', artifact}`
và **dừng nhánh** bằng một promise; `useCompanyPipeline.approve(id, ok, note)` resolve nó. Từ chối kèm note
→ note được đưa lại vào `incoming` của vai để làm lại (YC4.3). Cổng **cấp quyền** (sensitive action) tái
dùng cơ chế `permission` đã có trong `companyConversation`/PermissionPanel.

### 5. Vòng Test (YC5)

`testGate.runTest(scenario)`:

- Gọi Testing qua **bridge sẵn có** (`testingClient.run` / `testing.run` → `testOrchestrator.run`). Chờ
  kết quả; đính report .md vào artifacts.
- Pass → trả lên lead. Fail → đưa report lỗi lại cho vai thực thi sửa, lặp tới `MAX_TEST_ROUNDS` (vd 3).
- Lease/hàng đợi do Testing/ResourceCoordinator lo (đã có).

> Renderer gọi testing qua client bridge (giống `pages/testing`); không gọi thẳng Main module.

### 6. Concurrency & lease (YC6)

- Các **nhánh con độc lập** của cùng một vai chạy `Promise.all` nhưng mỗi `executeViaConversation` **xin
  lease `agent`** trước khi gửi → số agent chạy đồng thời = ngân sách RAM (YC6.2).
- Khi nhiều con trả về trong lúc vai cha đang "tổng hợp": kết quả vào **hàng đợi** trong `pipelineStore`
  theo nodeId; cha tiêu thụ tuần tự — không mất kết quả (YC6.1).
- **Deadlock guard**: cây vai là DAG (cha→con), `visited` chặn chu trình; chờ-lế leo có timeout (YC6.4).
- _(Giai đoạn sau)_ spawn "lead phụ" cùng soul/context để tiêu hàng đợi nhanh — đánh dấu TODO, không làm
  lần này (đã chốt tách).

### 7. Quan sát — Manager popup nâng cấp (YC7)

`pipelineStore` giữ: `Map<nodeId, RoleRunState>` (activity, talkingToId, task), `messages[]` (cây),
`artifacts[]` (doc/report/test/changedFiles), `pendingApprovals[]`. `useCompanyPipeline` expose cho UI.

- `RoleTreeBoard.tsx`: vẽ cây đệ quy + trạng thái + cạnh ai-nói-với-ai.
- `ArtifactList.tsx`: list artifact, mở file qua Universal Editor (`/editor` hoặc adapter) nếu là file thật.
- ManagerPopup thêm switch chế độ **Pipeline (làm thật)** / **Conversation (diễn nhanh)**; nút Dừng huỷ
  phiên + dọn lease + (tùy chọn) để conversation lại cho user xem.

### Mô hình sự kiện (PipelineEvent)

```
run-started {runId, rootId, participants[]}
role-status {runId, nodeId, activity, talkingToId?, task?}
message {runId, fromId, toId, content, kind:'directive'|'report'|'note'}
execute-started {runId, nodeId, conversationId, workspace}
execute-finished {runId, nodeId, ok, resultPreview, artifactId?}
approval {runId, requestId, fromId, artifact, summary}
approval-resolved {runId, requestId, approved, note?}
test-started {runId, nodeId, scenarioId}
test-finished {runId, nodeId, passed, reportPath}
artifact {runId, artifact}
run-finished {runId, status:'done'|'stopped'|'error', summary}
run-error {runId, message}
```

## Mô hình dữ liệu

```ts
type RoleRunState = {
  nodeId: string;
  name: string;
  role: 'president' | 'division-head' | 'worker';
  activity:
    | 'idle'
    | 'planning'
    | 'delegating'
    | 'executing'
    | 'awaiting-approval'
    | 'testing'
    | 'summarizing'
    | 'done'
    | 'failed';
  talkingToId?: string;
  task?: string;
  conversationId?: string;
  updatedAt: number;
};
type Artifact = {
  id: string;
  nodeId: string;
  kind: 'doc' | 'report' | 'test-report' | 'code-change' | 'note';
  title: string;
  path?: string;
  preview?: string;
  simulated?: boolean;
  at: number;
};
type RoleResult = { ok: true; result: string; artifactIds: string[] } | { ok: false; error: string };
```

## Xử lý lỗi

- Executor timeout/treo → huỷ lượt, trả `{ok:false}` lên cha, đánh dấu role `failed`, không sập phiên (YC2.5/3.6).
- Test fail quá `MAX_TEST_ROUNDS` → báo lên lead kèm report; lead quyết theo soul.
- Approval bị từ chối nhiều lần → vẫn cho làm lại đến giới hạn vòng, rồi báo cha.
- Hủy phiên (Stop) → AbortController phát xuống mọi nhánh; release toàn bộ lease; dừng chờ turn.
- Model không cấu hình / model chặn chat trực tiếp → `run-error` rõ ràng (như generate/detect trước đây).

## Chiến lược kiểm thử

- **Unit/property (renderer logic thuần, DI hết I/O):**
  - `roleRunner`: đệ quy gom đúng (A→B→C/D), chỉ giao con trực tiếp, chống chu trình, depth guard, lỗi nhánh
    không sập (mock planner + executor).
  - hàng đợi kết quả khi nhiều con xong cùng lúc (YC6.1).
  - `delegationPlanner` parse directive JSON; loại childId không phải con trực tiếp.
  - `approvalGate`/`testGate`: pause/resume, fail→retry loop (mock test client).
  - lease balance: mỗi execute có đúng 1 release (mock coordinator).
- **DOM test:** ManagerPopup chế độ Pipeline render cây đệ quy từ event stream; duyệt artifact; nút Stop.
- `bunx tsc --noEmit` sạch; i18n đủ 9 locale; getDiagnostics sạch.

## Quyết định & đánh đổi

- **Orchestrator ở renderer** (không Main): để tái dùng API conversation/turn thật, tránh bắc cầu IPC mới.
  Đánh đổi: logic nặng ở renderer — chấp nhận vì nó chỉ điều phối (I/O-bound), việc nặng thật nằm trong CLI
  agent (process riêng do aioncore quản) và đã có lease.
- **Giữ cả 2 engine** (conversation diễn + pipeline thật): không xoá công sức cũ; cho người dùng chọn.
- **Workflow trong soul, không trong code**: tổng quát cho mọi loại công ty; rủi ro là model viết soul kém →
  có `soulTemplates` mặc định + người dùng sửa được.
- **Worker làm trên task/file tách biệt** lần này (chốt): tránh xung đột ghi song song; auto-merge để sau.
- **Spawn lead phụ**: hoãn (đã chốt) — làm lõi trước.

```

```
