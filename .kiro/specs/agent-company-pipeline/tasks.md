# Implementation Plan — Agent Company Pipeline

## Overview

Kế hoạch triển khai **công ty tác nhân làm việc thật, đệ quy, do soul/rule điều khiển** (xem
[`requirements.md`](./requirements.md) + [`design.md`](./design.md)). Ngôn ngữ: **TypeScript** (Electron +
Vite + React + Bun). Không sửa aioncore. Orchestrator thực thi nằm ở **renderer** (tái dùng
`ipcBridge.conversation` + `turn.completed` + `companySession`). Engine model-chat cũ (`companyConversation`)
giữ nguyên làm chế độ "diễn".

Quy ước: mọi I/O inject để test được; lease `agent` quanh mỗi lượt thực thi; chuỗi UI qua `t()`; Arco +
UnoCSS semantic token; ≤10 children/thư mục. Test bằng Vitest 4 (`tests/unit/company/**`,
`*.dom.test.tsx` cho DOM).

## Quy tắc chạy

1. Làm tuần tự theo số task; cập nhật `[ ]`→`[x]` ngay khi xong.
2. Gặp lỗi: tự sửa tối đa 2 lần (systematic-debugging). Không xong → đánh `[-]`, ghi Nhật ký lỗi, đi tiếp.
3. Sau mỗi nhóm: `bunx tsc --noEmit` + test liên quan + (nếu đụng locale) `i18n:types` + `check-i18n.js`.
4. UI: kích hoạt `frontend-design`, render Arco + UnoCSS + i18n. KHÔNG dùng Claude computer-use để test.

## Tasks

- [x] 1. Nền — types + soul mang workflow
  - [x] 1.1 Tạo `renderer/pages/company/pipeline/pipelineTypes.ts`
    - `PipelineEvent` (union như design), `RoleRunState`, `Artifact`, `RoleResult`, `RunConfig`
      (maxDepth/maxTestRounds/executeTimeoutMs/estCostMB), `Directive`, `PlannerDecision`.
    - _Requirements: 2, 3, 7_

  - [x] 1.2 Tạo `process/company/soulTemplates.ts` (Main, thuần)
    - `defaultSoulForRole(role, ctx)` → markdown workflow mặc định (president/division-head/worker) khi AI
      bỏ trống; `ensureSoulHasWorkflow(soul, role, ctx)` (nếu trống/thiếu → bồi mặc định).
    - _Requirements: 1.1, 1.5_

  - [-] 1.3 Sửa `process/company/companyConfig.ts` — `buildRoleChartPrompt`
    - **SUPERSEDED:** thay vì model sinh + persist soul, ta **compose soul lúc chạy** từ
      role+responsibilities+direct-reports+rules (`pipeline/soulComposer.ts`). Editable, không cần persist
      → đáp ứng YC1 mà không sửa companyConfig/schema. Giữ `soulTemplates.ts` làm fallback mặc định.
    - _Requirements: 1.1, 1.3_

  - [x] 1.4 Unit test soulTemplates + parse soul
    - default soul có đủ mục workflow; parse bỏ qua soul rác; role không có soul → fallback template.
    - _Requirements: 1.1, 1.5_

- [x] 2. Delegation planner (model quyết giao/làm)
  - [x] 2.1 Tạo `pipeline/delegationPlanner.ts`
    - `plan({node, soul, memory, rules, incoming, directChildren, chat})` → `PlannerDecision`
      (`delegate|execute|request_approval|request_test|finish`). Prompt nhồi soul + danh sách **con trực
      tiếp** (id/tên/trách nhiệm). Parse JSON fenced; **loại directive có childId không phải con trực tiếp**.
    - DI `chat` (model call) — tái dùng kiểu `CompanyChat`/providerChat.
    - _Requirements: 1.2, 2.1, 2.4_

  - [x] 2.2 Unit test planner
    - parse delegate/execute/approval/test/finish; chặn nhảy cóc (childId lạ bị bỏ); JSON rác → finish an toàn.
    - _Requirements: 2.1, 2.4_

- [x] 3. Role executor (THỰC THI THẬT qua conversation)
  - [x] 3.1 Tạo `pipeline/roleExecutor.ts`
    - `executeViaConversation({node, briefing, task, deps})`: resolve executor (tái dùng
      `companySession.buildParamsForRole`), tạo/định vị conversation (nhớ map role→convId), `sendMessage`,
      **chờ** `turnCompleted` đúng session tới `finished`+`can_send_message`, lấy `last_message.content`.
    - Bọc lease `agent` (DI coordinator); **timeout** + **AbortSignal** (huỷ). Trả `{result, workspace}`.
    - DI hết I/O (createConversation/sendMessage/onTurnCompleted/requestLease) để test không cần IPC.
    - _Requirements: 3.1, 3.2, 3.3, 3.5, 3.6_

  - [x] 3.2 Fallback khi vai chưa gán executor
    - Không có executor chạy được → trả artifact `simulated:true` (model-chat mô tả) + đánh dấu rõ; KHÔNG
      treo. (Tùy chọn: gợi ý draft — chỉ ghi chú, không tự tạo.)
    - _Requirements: 3.4_

  - [x] 3.3 Unit test roleExecutor (mock IPC)
    - happy path (turn finished → result); timeout → {ok:false} + release lease; abort giữa chừng; lease
      balance (1 request = 1 release); fallback simulated khi không executor.
    - _Requirements: 3.1, 3.4, 3.5, 3.6_

- [x] 4. Recursive runner (lõi đệ quy)
  - [x] 4.1 Tạo `pipeline/roleRunner.ts`
    - `runRole(node, incoming, ctx)`: nạp soul/memory/rules → `delegationPlanner.plan` → nhánh:
      `execute`→roleExecutor; `delegate`→`Promise.all(directives.map(d→runRole(child,…)))` rồi tổng hợp;
      `request_approval`→approvalGate; `request_test`→testGate; `finish`→trả result.
    - **Guard:** depth ≤ maxDepth; `visited:Set<nodeId>` chống chu trình; lỗi nhánh → `{ok:false}` lên cha,
      role `failed`, không throw ra ngoài.
    - Emit `PipelineEvent` qua sink (status/message/execute/…); cập nhật `talkingToId` khi giao việc.
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5_

  - [x] 4.2 Hàng đợi kết quả con (concurrency)
    - Khi nhiều con xong trong lúc cha đang tổng hợp: kết quả vào queue theo nodeId; cha tiêu thụ tuần tự,
      không mất kết quả. Mức song song do lease quyết (không cố định cứng).
    - _Requirements: 6.1, 6.2, 6.4_

  - [x] 4.3 Property/unit test runner
    - A→B→C/D gom đúng (thứ tự + nội dung); chỉ giao con trực tiếp; chu trình bị chặn; depth guard; 1 nhánh
      lỗi không sập phiên; queue không mất kết quả khi nhiều con xong cùng lúc (seeded, mock planner/executor).
    - _Requirements: 2.2, 2.3, 2.4, 2.5, 6.1_

- [x] 5. Cổng duyệt + vòng test
  - [x] 5.1 Tạo `pipeline/approvalGate.ts` - `requestApproval({artifact, summary, fromId})` → emit `approval` + trả promise; `resolve(requestId,
approved, note)` settle. Từ chối kèm note → đưa note vào `incoming` để vai làm lại. Tái dùng kiểu
        permission đã có cho "cấp quyền". - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5_

  - [x] 5.2 Tạo `pipeline/testGate.ts`
    - `runTest(scenario)` gọi testing client bridge (`testing.run`) → chờ report; pass→trả; fail→đưa report
      lỗi lại vai thực thi sửa, lặp tới maxTestRounds; đính report .md vào artifacts.
    - DI testing client để test.
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

  - [x] 5.3 Unit test approvalGate + testGate
    - approve/deny+retry; test pass-through; test fail→retry loop tới giới hạn; report đính artifact.
    - _Requirements: 4.2, 4.3, 5.2, 5.3_

- [x] 6. Pipeline store + facade + hook
  - [x] 6.1 Tạo `pipeline/pipelineStore.ts`
    - State phiên: `Map<nodeId,RoleRunState>`, `messages[]`, `artifacts[]`, `pendingApprovals[]`; reducer
      theo `PipelineEvent`; subscribe/emit.
    - _Requirements: 7.1, 7.2, 7.3_

  - [x] 6.2 Tạo `pipeline/companyPipeline.ts` (facade)
    - `runCompany({companyId, structure, rules, goal, model, config})`: dựng ctx (chat, executor deps, lease,
      testClient, approvalGate), gọi `runRole(root, {task:goal})`, đẩy event vào store; `stop()` (Abort +
      release); `approve()`, `resolvePermission()`.
    - _Requirements: 2, 3, 4, 5, 6, 8.2_

  - [x] 6.3 Tạo `useCompanyPipeline.ts` (hook)
    - Nối store→React: phase/tree(states)/messages/artifacts/pending; actions start/approve/resolvePermission/stop.
    - _Requirements: 7_

  - [x] 6.4 Unit test store reducer
    - mỗi PipelineEvent cập nhật đúng; pending add/remove; artifacts append.
    - _Requirements: 7.1_

- [-] 7. Wiring soul khi tạo công ty
  - [-] 7.1 Ghi soul mỗi vai khi tạo/sửa công ty
    - **SUPERSEDED bởi `soulComposer` (compose lúc chạy).** Không persist soul, không thêm bridge
      get-soul/set-soul — soul dựng từ structure+rules mỗi lần chạy, nên sửa responsibilities/rules ở UI là
      lần chạy sau đổi theo (đáp ứng YC1.4) mà không cần round-trip lưu trữ.
    - _Requirements: 1.1, 1.4_

  - [-] 7.2 Unit test set/get soul + dùng bản mới
    - **SUPERSEDED:** soulComposer là hàm thuần — phủ bởi `soulComposer.test.ts` (compose đúng theo role +
      direct reports + rules; default templates đủ workflow).
    - _Requirements: 1.4_

- [x] 8. Manager popup — chế độ Pipeline (UI)
  - [x] 8.1 `manager/RoleTreeBoard.tsx`
    - Cây đệ quy (President→head→worker) + trạng thái mỗi vai + cạnh ai-nói-với-ai; accent/pulse theo
      activity. Arco + UnoCSS token.
    - _Requirements: 7.1, 7.2_

  - [x] 8.2 `manager/ArtifactList.tsx`
    - List artifact (doc/report/test-report/code-change), mở file qua Universal Editor nếu có path; badge
      `simulated`.
    - _Requirements: 7.3_

  - [x] 8.3 Sửa `manager/ManagerPopup.tsx` — switch chế độ Pipeline/Conversation
    - Mặc định Pipeline khi structure có executor; dùng `useCompanyPipeline`. Hiện RoleTreeBoard +
      ArtifactList + PermissionPanel + approval; nút Dừng (stop + dọn lease). Giữ chế độ Conversation cũ.
    - _Requirements: 4.4, 7.1, 7.3, 7.4, 7.5_

  - [x] 8.4 i18n module `company.pipeline.*` (9 locale)
    - activity labels, pipeline/conversation switch, artifact kinds, approval doc, test states, stop. Chạy
      `i18n:types` + `check-i18n.js`.
    - _Requirements: 7.6, 8.4_

  - [x] 8.5 DOM test ManagerPopup (Pipeline)
    - render cây đệ quy từ event stream; duyệt artifact; approval approve gọi đúng; nút Stop gọi stop.
    - _Requirements: 7.1, 7.4, 7.5_

- [x] 9. Checkpoint — tích hợp + verify
  - `bunx tsc --noEmit` sạch; `bunx vitest run tests/unit/company/` pass; `check-i18n.js` không thiếu key
    `company`. Cập nhật `docs/CODEBASE_GUIDE.md` (mục Company + pages/company/pipeline). Ghi `.kiro/status.md`.
  - Nghiệm thu thật do người dùng: `bun start` → Company → gán CLI cho các vai → Manager → Pipeline → goal.
  - _Requirements: tất cả_

- [x] 10. Năng lực vai trò + fix lỗi "ACP requires backend" (Yêu cầu 9)
  - [x] 10.1 `RoleAssignment.capabilities` + `RoleCapabilities` (companyOrchestrator) + parse/persist
        (`normaliseCapabilities` trong companyConfig, round-trip cả per-worker).
  - [x] 10.2 `ListAgentsResponse`/`fetchAgentPool` +mcpServers/skills/modes; designer prompt
        (`buildRoleChartPrompt`) liệt kê pool + dạy AI gán `capabilities`.
  - [x] 10.3 FIX bug: `acceptDrafts` clamp `preset_agent_type` về engine thật; `buildParamsForRole`
        validate + fallback engine khi mở chat (hết lỗi "ACP agent requires backend").
  - [x] 10.4 `openRoleChat` bơm capabilities vào conversation extra (mcp/skills/session_mode).
  - [x] 10.5 UI: AssignmentEditor +MCP/Skills/Mode (mọi vai gồm worker); RoleTree chip năng lực; i18n 9 locale.
  - [x] 10.6 Test `companyCapabilities.test.ts` (round-trip + nạp phòng thủ) + thanh tiến trình
        `GenerationProgress` (9 locale). tsc sạch, vitest company 104/104, check-i18n pass.
  - _Requirements: 9_

## Notes

- **Soul = workflow, dựng lúc chạy** (`pipeline/soulComposer.ts`) từ role + responsibilities + direct
  reports + rules → mỗi loại công ty có quy trình riêng mà không hardcode; sửa ở UI là lần chạy sau đổi
  theo (YC1). `process/company/soulTemplates.ts` là fallback mặc định khi cần.
- **Thực thi thật (B)** qua `conversation.sendMessage` + chờ `turn.completed` (`roleExecutor`), agent chạy
  trong workspace thật. Orchestrator nằm ở renderer để tái dùng API conversation/turn (không sửa aioncore).
- **Hoãn (giai đoạn sau):** spawn "lead phụ" cùng model/context (YC6.3); auto-merge code song song cùng file.
- Sau khi sửa locale: `bun run i18n:types` + `node scripts/check-i18n.js`.

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "2.1", "3.1", "5.1", "5.2"] },
    { "id": 2, "tasks": ["1.4", "2.2", "3.2", "3.3", "5.3", "6.1"] },
    { "id": 3, "tasks": ["4.1", "6.2"] },
    { "id": 4, "tasks": ["4.2", "6.3", "7.1"] },
    { "id": 5, "tasks": ["4.3", "6.4", "7.2"] },
    { "id": 6, "tasks": ["8.1", "8.2"] },
    { "id": 7, "tasks": ["8.3", "8.4"] },
    { "id": 8, "tasks": ["8.5"] },
    { "id": 9, "tasks": ["9"] }
  ]
}
```

> File chung tuần tự (một agent tại một thời điểm): `companyConfig.ts` (1.3/7.1), `companyBridge.ts` +
> client (7.1), `ManagerPopup.tsx` (8.3), `i18n-config.json` + locale (8.4). Các file pipeline mới độc lập
> → song song được.

## Nhật ký lỗi

_(chưa có)_
