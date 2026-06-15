# Implementation Plan

## Overview

Kế hoạch triển khai tính năng **Manager** (Tasks + Note + Schedule, có AI) chia thành các bước code tăng
dần, mỗi bước nối tiếp bước trước và kết thúc bằng nối dây (wiring) vào ứng dụng — không để lại code mồ
côi. Ngôn ngữ: **TypeScript** (Electron + Vite + React + Bun), bám đúng [`design.md`](./design.md),
[`requirements.md`](./requirements.md), và `docs/CODEBASE_GUIDE.md`.

Quy ước nền móng (áp dụng xuyên suốt):

- **Không sửa aioncore.** Logic ở Main process (`process/manager/`); UI ở renderer (`pages/manager/`).
- Lưu cục bộ bằng tệp JSON (`manager-data.json`), ghi atomic (tmp→rename), nạp phòng thủ.
- AI gọi qua model người dùng (`providerChat.ts`); lời gọi nặng đi qua `ResourceCoordinator.requestLease`.
- Hai mặt phẳng: IPC bridge (UI) + built-in MCP server (agent), cùng một service.
- UI: `@arco-design/web-react` + `@icon-park/react` + UnoCSS semantic token, mọi chuỗi qua `t('key')`,
  light/dark, `prefers-reduced-motion`. Tối đa 10 children mỗi thư mục.
- Test bằng Vitest 4 (đặt ở `tests/unit/manager/**`). Task có dấu `*` là property/edge test tăng cường.

## Tasks

- [x] 1. Nền dữ liệu — types + store cục bộ
  - [x] 1.1 Định nghĩa kiểu dữ liệu Manager
    - Tạo `process/manager/managerTypes.ts`: `Task`, `Subtask`, `TaskKind`, `Priority`, `TaskStatus`,
      `RecurrenceRule`, `Reminder`, `Note`, `CalendarEvent`, `EventLockKind`, `ManagerSettings`,
      `ManagerData` (version 1)
    - _Requirements: 1.1, 1.2, 1.3, 5.1, 6.5, 7.1_

  - [x] 1.2 Hiện thực `managerStore` (CRUD + persist atomic + nạp phòng thủ)
    - Tạo `process/manager/managerStore.ts`: load/getData + mutator tasks/notes/events/settings; ghi
      `manager-data.json` (tmp→rename, mode 0o600); DI `{ dir?, fs? }`; type guard bỏ bản ghi sai shape;
      `onChange` để push; sinh lần kế cho task `recurring` khi toggle done
    - _Requirements: 1.1, 1.3, 1.4, 1.6, 1.7, 5.1, 5.5, 6.11, 9.2_

  - [x] 1.3 Viết unit test `managerStore`
    - CRUD round-trip (in-memory fs), nạp phòng thủ (file hỏng/thiếu trường), sinh lần kế recurring
    - **Property 2: Ghi đĩa an toàn (round-trip)** + **Property 3: Nạp phòng thủ**
    - **Validates: Requirements 1.6, 1.7, 5.5, 6.11, 9.2**

- [x] 2. AI helpers (parse/optimize) qua model người dùng
  - [x] 2.1 Hiện thực `managerAi.parseTasks` + `reviewTasks`
    - Tạo `process/manager/managerAi.ts`: nhận `AgentChat` (createProviderChat); `parseTasks(description)`
      → `Task[]` đề xuất (prompt JSON, validate); `reviewTasks(tasks)` → gợi ý; bọc lease `agent`; KHÔNG
      ghi store
    - _Requirements: 2.1, 2.5, 2.6, 3.4, 3.5_

  - [x] 2.2 Bổ sung `parseSchedule` + `parseScheduleImage` (vision)
    - Thêm vào `managerAi.ts`: `parseSchedule(text)` → `CalendarEvent[]` (mặc định flexible);
      `parseScheduleImage(imageDataUrl)` → `CalendarEvent[]` (mặc định fixed) gửi multimodal
      (`content:[{type:'text'},{type:'image_url'}]`); phân loại lỗi vision
    - _Requirements: 6.4, 6.5, 6.6, 6.7_

  - [x] 2.3 Hiện thực `weatherProvider` (Open-Meteo, degrade an toàn)
    - Tạo `process/manager/weatherProvider.ts`: geocode + forecast Open-Meteo (không cần khoá), `fetch`
      injectable; lỗi/offline/thiếu địa điểm → `null`
    - _Requirements: 8.3, 8.4_

  - [x] 2.4 Hiện thực `managerAi.optimizeSchedule` (giữ nguyên lịch cứng)
    - Thêm `optimizeSchedule({events,tasks,weather})` → `{proposed, rationale, weatherUsed}`; nhồi 5 yếu
      tố; **không đụng** event `fixed`; bọc lease; KHÔNG ghi store
    - _Requirements: 7.2, 8.1, 8.2, 8.3, 8.5, 8.7_

  - [x] 2.5 Viết unit/property test cho `managerAi` + `weatherProvider`
    - parse (mock AgentChat JSON), parse image gọi đúng shape multimodal, weather degrade (mock fetch)
    - **Property 1: Lịch cứng bất khả xâm phạm** + **Property 4: Đề xuất không tự ghi** + **Property 6: AI nặng đi qua lease**
    - **Validates: Requirements 7.2, 8.2, 2.2, 8.5, 2.6, 8.7**

- [x] 3. Nhắc nhở (scheduler trong Main process — không đụng cron aioncore)
  - [x] 3.1 Hiện thực `reminderScheduler`
    - Tạo `process/manager/reminderScheduler.ts`: `start()` chạy catch-up (phát reminder quá hạn chưa
      phát) rồi `setInterval` 60s; `snooze`/`dismiss`; DI `{ notify, now, store }`; notify mặc định =
      `showNotification` (tôn trọng `system.notificationEnabled`)
    - _Requirements: 3.1, 3.2, 3.3, 3.6_

  - [x] 3.2 Viết unit test `reminderScheduler`
    - catch-up phát đúng reminder quá hạn, không phát lại, snooze hoãn đúng (mock clock + notify)
    - **Property 5: Nhắc nhở không phát lại**
    - **Validates: Requirements 3.2, 3.3, 3.6**

- [x] 4. Bridge (UI plane) + wiring service
  - [x] 4.1 Hiện thực `managerBridge` + `managerWiring`
    - Tạo `process/manager/managerBridge.ts`: `MANAGER_CHANNELS` + `bridge.buildProvider`, envelope
      `ManagerResult<T>` (luôn resolve), `safe()` wrap, push `manager.data-changed`; tạo
      `process/manager/managerWiring.ts`: `getManagerServices()` (store + ai + scheduler, lazy singleton)
    - _Requirements: 2.4, 6.12, 8.8, 9.4, 9.6_

  - [x] 4.2 Viết unit test `managerBridge` (envelope + safe)
    - kênh trả `{ok:true}`/`{ok:false,code}`; `no-model`/`no-vision` phân loại đúng; không reject
    - **Validates: Requirements 2.4, 6.7, 8.8, 9.6**

- [x] 5. Agent plane — built-in MCP server
  - [x] 5.1 Hiện thực `managerServer` (MCP) + hằng định danh
    - Thêm hằng `BUILTIN_MANAGER_*` + helper `isBuiltinManager*` vào `process/resources/builtinMcp/constants.ts`;
      tạo `process/resources/builtinMcp/managerServer.ts` (stdio) đọc env `AIONUI_MANAGER_DATA_DIR`, dựng
      store cùng file; tools `manager_list_tasks/add_task/update_task/add_note/list_events/add_event`
    - _Requirements: 9.3_

- [x] 6. UI renderer — ManagerPage + 3 tab
  - [x] 6.1 Khung trang + hook + bridge client
  - [x] 6.2 Tab Tasks (khoa học tâm lý) + tạo bằng AI
  - [x] 6.3 Tab Note
  - [x] 6.4 Tab Schedule (ngày/tuần, cứng/tự do, nhập tay/prompt/ảnh, tối ưu)
  - [x] 6.5 Viết DOM test `ManagerPage`

- [x] 7. Tích hợp toàn cục (route + nav + bridge + MCP + i18n)
  - [x] 7.1 Route + nav entry
  - [x] 7.2 Đăng ký bridge + start scheduler ở bootstrap
  - [x] 7.3 Đăng ký built-in MCP + i18n module

- [x] 8. Checkpoint — typecheck + toàn bộ test manager pass + kiểm UI tự động
  - `bunx tsc --noEmit` sạch; `bunx vitest run tests/unit/manager/` pass; `node scripts/check-i18n.js` không
    thiếu key `manager`
  - Kiểm UI theo `.kiro/steering/claude-ui-testing.md` (rule mới): DOM test (`ManagerPage.dom.test.tsx`) +
    typecheck/lint/i18n. KHÔNG dùng Claude/computer-use. App thật để NGƯỜI DÙNG tự `bun start` nghiệm thu.
  - _Requirements: tất cả_

## Task Dependency Graph

> `waves` dùng khi chạy nhiều sub-agent song song (xem `.kiro/steering/subagent-parallel.md`): mỗi wave
> gồm các task **độc lập về file**; task đụng file chung / tích hợp chạy tuần tự. Khi chạy một agent, cứ
> theo thứ tự số task.

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.3"] },
    { "id": 2, "tasks": ["1.3", "2.1", "3.1"] },
    { "id": 3, "tasks": ["2.2", "2.4", "3.2"] },
    { "id": 4, "tasks": ["2.5", "4.1"] },
    { "id": 5, "tasks": ["4.2", "5.1"] },
    { "id": 6, "tasks": ["6.1"] },
    { "id": 7, "tasks": ["6.2", "6.3", "6.4"] },
    { "id": 8, "tasks": ["6.5"] },
    { "id": 9, "tasks": ["7.1", "7.2", "7.3"] },
    { "id": 10, "tasks": ["8"] }
  ]
}
```

Ghi chú phụ thuộc chính:

- `1.1` (types) là gốc — mọi thứ phụ thuộc nó.
- `1.2` store là nền cho `managerAi`, `reminderScheduler`, bridge, MCP.
- `2.3` weatherProvider độc lập file, có thể chạy sớm song song với store.
- File chung tuần tự: `process/bridge/index.ts` (7.2), `builtinMcp/constants.ts` + `i18n-config.json`
  (5.1, 7.3), `Router.tsx` + `Sider/index.tsx` (7.1) — chỉ một agent sửa tại một thời điểm.
- `6.2`/`6.3`/`6.4` là các tab khác thư mục con (`tasks/`, `notes/`, `schedule/`) → song song được; nhưng
  đều phụ thuộc `6.1` (khung + hook + client) nên chạy sau.

## Notes

- **Không đụng aioncore.** Nếu phát hiện một yêu cầu buộc phải sửa Rust backend, dừng và ghi `.kiro/status.md`
  (theo `autonomous-run.md`).
- **Lưu file cục bộ** `manager-data.json` trong `userData`; ghi atomic; nạp phòng thủ. Không upload.
- **AI qua model người dùng** (`providerChat.ts`); chưa cấu hình → `code:'no-model'`; model không vision →
  `code:'no-vision'`. UI hiện gợi ý tương ứng, không treo.
- **Đề xuất trước, áp dụng sau** cho mọi thao tác AI; tối ưu lịch giữ snapshot để undo.
- **Lịch cứng (fixed) bất khả xâm phạm** khi tối ưu — bất biến chính, có property test.
- **i18n:** sau khi sửa locale/`i18n-config.json` chạy `bun run i18n:types` + `node scripts/check-i18n.js`.
- **UI test thật** bằng Claude computer-use theo `.kiro/steering/claude-ui-testing.md`; DEFER được nếu
  router không phản hồi (như 4.12).

## Nhật ký lỗi (điền khi gặp lỗi không sửa được sau 2 lần)

_(chưa có)_
