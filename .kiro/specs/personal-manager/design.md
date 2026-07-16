# Design Document

> **Tính năng:** **Manager** — Personal Manager (Tasks + Note + Schedule, có AI hỗ trợ).
> **Dự án:** Tomni Agentic (fork của [AionUi](https://github.com/VNDT1625/OmniAgent), VNDT1625, Apache-2.0).
> **Spec liên quan:** [`requirements.md`](./requirements.md)
> **Cập nhật:** 2026-05-31

## Overview

Manager là một "ứng dụng trong ứng dụng" cấp cao (top-level app, như Studio) gồm ba phần: **Tasks**,
**Note**, **Schedule**. Thiết kế bám đúng ba sự thật kiến trúc của codebase (xem `docs/CODEBASE_GUIDE.md`
và `.kiro/specs/aionui-enhancements/design.md`) và **không sửa aioncore**:

1. **Logic ở Main process (Node.js).** Một service `managerStore` giữ toàn bộ dữ liệu (tasks, notes,
   events, settings) dưới dạng **tệp JSON cục bộ** trong thư mục `userData`, dùng đúng pattern ghi atomic
   (write-tmp → rename, `mode 0o600`) và nạp phòng thủ của `resourceState.ts`.
2. **Hai mặt phẳng truy cập:** (A) **IPC bridge** `managerBridge` cho UI renderer; (B) **built-in MCP
   server** `managerServer` cho agent — cả hai gọi **cùng một** `managerStore`.
3. **AI gọi qua model người dùng** theo pattern `providerChat.ts` (đọc `GET /api/providers` → `POST
/chat/completions`), bao gồm cả lời gọi **đa phương thức (vision)** để đọc ảnh thời khoá biểu. Không
   hardcode key; chưa cấu hình model → báo lỗi thân thiện.

### Bản đồ Yêu cầu → Thành phần

| Yêu cầu                              | Thành phần chính                                                                            | Vị trí                                        | Cần backend?                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------- |
| **1 — Tasks CRUD + loại task**       | `managerStore` (tasks) + `managerTypes`                                                     | `process/manager/`                            | Không                                    |
| **2 — Tạo task từ mô tả (AI)**       | `managerAi.parseTasks` + `providerChat`                                                     | `process/manager/`                            | Không                                    |
| **3 — AI quản lý + nhắc nhở**        | `reminderScheduler` (ticker) + `notificationBridge` (có sẵn) + `managerAi.reviewTasks`      | `process/manager/`                            | Không                                    |
| **4 — UI Tasks khoa học tâm lý**     | `TasksView` + components                                                                    | `renderer/pages/manager/`                     | Không                                    |
| **5 — Note**                         | `managerStore` (notes) + `NotesView`                                                        | `process/manager/`, `renderer/pages/manager/` | Không                                    |
| **6 — Schedule nhập tay/prompt/ảnh** | `managerStore` (events) + `managerAi.parseSchedule` / `parseScheduleImage` + `ScheduleView` | `process/manager/`, `renderer/pages/manager/` | Không                                    |
| **7 — Lịch cứng/tự do**              | trường `lockKind` trên event + ràng buộc tối ưu                                             | `process/manager/`                            | Không                                    |
| **8 — Tối ưu lịch (AI)**             | `managerAi.optimizeSchedule` + `weatherProvider`                                            | `process/manager/`                            | Không (thời tiết = mạng ngoài, tắt được) |
| **9 — Tích hợp/lưu/MCP/i18n**        | route + nav + `managerBridge` + `managerServer` + i18n module `manager`                     | nhiều nơi                                     | Không                                    |

### Phạm vi & nguyên tắc

- Manager là công cụ **cá nhân, đơn-model** — KHÔNG dùng Team/Company multi-agent. Không trùng với
  cron/scheduled-tasks hiện có (cron = lập lịch chạy _tác vụ agent_; Manager = quản lý _việc cá nhân_).
- Mọi lời gọi AI "nặng" (parse ảnh, tối ưu lịch) đi qua `ResourceCoordinator.requestLease({ kind: 'agent' })`.
- UI: `@arco-design/web-react` + `@icon-park/react` + UnoCSS semantic token + i18n. Renderer không Node API.
- Mỗi thư mục ≤ 10 children → chia module con khi gần chạm giới hạn.

## Architecture

### Sơ đồ thành phần

```
┌───────────────────────────── Electron App ─────────────────────────────┐
│                                                                         │
│  Renderer (React)                          Main process (Node.js)       │
│  ┌─────────────────────────┐               ┌─────────────────────────┐  │
│  │ pages/manager/          │  IPC bridge   │ process/manager/        │  │
│  │  ManagerPage (tabs)     │ ◄───────────► │  managerBridge          │  │
│  │   - TasksView           │  manager.*    │   (UI plane)            │  │
│  │   - NotesView           │               │      │                  │  │
│  │   - ScheduleView        │               │      ▼                  │  │
│  │  useManagerStore (hook) │               │  managerStore (1 nguồn) │  │
│  └─────────────────────────┘               │   - tasks/notes/events  │  │
│                                             │   - manager-data.json   │  │
│                                             │      ▲        ▲         │  │
│  Agent (CLI/assistant)                      │      │        │         │  │
│  ┌─────────────────────────┐  stdio MCP    │  managerAi   reminder    │  │
│  │ builtin MCP client      │ ◄───────────► │  (providerChat) Scheduler│  │
│  └─────────────────────────┘  manager_*    │      │                  │  │
│                                             │      ▼   weatherProvider │  │
│  builtinMcp/managerServer.ts ───────────────┘  (GET /api/providers)   │  │
│   (standalone node proc)                       /chat/completions        │  │
└─────────────────────────────────────────────────────────────────────────┘
```

### Quyết định kiến trúc chính

1. **Top-level app, không phải settings tab.** Manager là không gian làm việc riêng (ba phần lớn), nên
   đăng ký route `/manager` và một entry nav cấp cao (mirror `SiderStudioEntry`), KHÔNG nhét vào
   `/settings/*` như Resource/Company. Lý do: trải nghiệm "ứng dụng riêng" + đủ chỗ cho 3 tab.
2. **Một service, hai mặt phẳng.** `managerStore` là nguồn chân lý duy nhất (file `manager-data.json`).
   `managerBridge` (UI) và `managerServer` (MCP, tiến trình node riêng) đều đọc/ghi cùng file đó — giống
   cách `resourceBridge`/`resourceServer` chia sẻ `resource-state.json`. MCP server nhận đường dẫn thư mục
   dữ liệu qua biến môi trường (mirror `RESOURCE_STATE_DIR_ENV_KEY`).
3. **Nhắc nhở tự lập lịch trong Main process — KHÔNG đụng cron aioncore.** `reminderScheduler` là một
   ticker `setInterval` trong Main process: mỗi phút quét các nhắc nhở tới hạn, phát qua `showNotification`
   (notificationBridge có sẵn). Nhắc nhở quá hạn khi app không chạy được "bắt kịp" (catch-up) ngay khi
   service khởi động: quét mọi reminder có `fireAt <= now` và `firedAt == null`, phát rồi đánh dấu đã phát.
   → Không cần HTTP API cron, không đụng backend.
4. **AI envelope luôn-resolve.** Mọi kênh bridge dùng envelope `ManagerResult<T> = {ok:true,data} |
{ok:false,error,code}` (giống `CompanyResult`) vì `@office-ai/platform` nuốt promise reject → tránh
   treo UI. `code: 'no-model'` cho "chưa cấu hình model", `code: 'no-vision'` cho "model không đọc ảnh".
5. **Đề xuất trước, áp dụng sau.** Tất cả thao tác AI (parse tasks, parse schedule, optimize) trả về
   **đề xuất** để renderer hiển thị xem trước; chỉ ghi vào store khi người dùng bấm chấp nhận. Tối ưu lịch
   giữ lại snapshot trước đó để undo.
6. **Thời tiết là phụ thuộc mạng ngoài, tắt được.** `weatherProvider` dùng **Open-Meteo** (miễn phí,
   KHÔNG cần API key, có geocoding). Khi tắt trong settings / offline / lỗi / thiếu địa điểm → bỏ qua yếu
   tố thời tiết (degrade) và ghi rõ trong kết quả tối ưu. Đây là lựa chọn để tránh khoá API cho người dùng.

## Components and Interfaces

### Main process — `packages/desktop/src/process/manager/`

Thư mục (≤ 10 children):

```
process/manager/
├── managerTypes.ts        ← types: Task, Note, CalendarEvent, Reminder, ManagerData, Optimize*
├── managerStore.ts        ← CRUD + atomic file persist (manager-data.json), DI fs/dir, nạp phòng thủ
├── managerAi.ts           ← parseTasks / reviewTasks / parseSchedule / parseScheduleImage / optimizeSchedule (qua providerChat)
├── weatherProvider.ts     ← Open-Meteo geocode + forecast, degrade an toàn, injectable fetch
├── reminderScheduler.ts   ← ticker quét reminder tới hạn + catch-up quá hạn, DI notifier/clock
├── managerBridge.ts       ← IPC bridge (UI plane): kênh manager.*, envelope ManagerResult
└── managerWiring.ts       ← getManagerServices(): dựng store + ai + scheduler (singleton, lazy)
```

#### `managerTypes.ts` (rút gọn)

```typescript
export type TaskKind = 'oneoff' | 'recurring' | 'habit' | 'milestone';
export type Priority = 'low' | 'medium' | 'high' | 'urgent';
export type TaskStatus = 'todo' | 'in_progress' | 'done';
export type RecurrenceRule = { freq: 'daily' | 'weekly' | 'monthly'; interval?: number; byWeekday?: number[] };

export type Reminder = {
  id: string;
  /** Mốc tuyệt đối (ms epoch) sẽ phát thông báo. */
  fireAt: number;
  /** Đã phát lúc nào (ms) — null nghĩa là chưa phát. */
  firedAt?: number | null;
  /** Tạm hoãn tới mốc này (snooze). */
  snoozedTo?: number | null;
};

export type Subtask = { id: string; title: string; done: boolean };

export type Task = {
  id: string;
  title: string;
  description?: string;
  kind: TaskKind;
  priority: Priority;
  status: TaskStatus;
  /** Hạn chót (ms epoch). */
  dueAt?: number | null;
  /** Ước lượng thời lượng (phút). */
  estimateMinutes?: number | null;
  tags: string[];
  subtasks: Subtask[];
  recurrence?: RecurrenceRule | null;
  reminders: Reminder[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number | null;
};

export type Note = {
  id: string;
  title?: string;
  /** Nội dung Markdown. */
  body: string;
  tags: string[];
  linkedTaskId?: string | null;
  linkedEventId?: string | null;
  createdAt: number;
  updatedAt: number;
};

/** Lịch cứng (không cho AI dời) hoặc tự do (AI sắp xếp được). */
export type EventLockKind = 'fixed' | 'flexible';

export type CalendarEvent = {
  id: string;
  title: string;
  startAt: number; // ms epoch
  endAt: number; // ms epoch
  lockKind: EventLockKind;
  location?: string | null;
  linkedTaskId?: string | null;
  note?: string | null;
  recurrence?: RecurrenceRule | null;
  /** Nguồn tạo: thủ công, từ prompt, từ ảnh, hoặc do AI tối ưu. */
  source: 'manual' | 'prompt' | 'image' | 'optimizer';
  createdAt: number;
  updatedAt: number;
};

export type ManagerSettings = {
  /** Bật/tắt yếu tố thời tiết khi tối ưu lịch. */
  weatherEnabled: boolean;
  /** Địa điểm mặc định để tra thời tiết khi event không có địa điểm. */
  defaultLocation?: string | null;
};

export type ManagerData = {
  version: 1;
  tasks: Task[];
  notes: Note[];
  events: CalendarEvent[];
  settings: ManagerSettings;
};
```

#### `managerStore.ts`

- API: `load()`, `getData()`, các mutator `addTask/updateTask/removeTask/toggleSubtask`,
  `addNote/updateNote/removeNote`, `addEvent/updateEvent/removeEvent`, `setEvents(events)` (cho áp dụng
  tối ưu + undo), `updateSettings`. Mỗi mutator ghi atomic ra `manager-data.json` rồi trả `ManagerData` mới.
- DI `{ dir?, fs? }` như `resourceState.ts` để test trên temp dir/in-memory.
- Nạp phòng thủ: parse JSON lỗi/thiếu trường → trả `ManagerData` rỗng hợp lệ; bỏ qua bản ghi sai shape
  (lọc theo type guard) thay vì ném.
- Recurring/habit: khi `toggle done` một task `recurring`, store sinh lần kế (clone với `dueAt` dời theo
  `recurrence`) — logic thuần, test được.

#### `managerAi.ts`

Tất cả nhận một `AgentChat` (từ `createProviderChat`, hỗ trợ multimodal pass-through như `webAgentRunner`)
và trả về **đề xuất** (không ghi store). Mỗi hàm bọc lease `agent` qua ResourceCoordinator.

- `parseTasks(description)` → `Task[]` đề xuất (prompt yêu cầu JSON; parse + validate; lỗi format → throw
  để bridge trả `ManagerResult` lỗi).
- `reviewTasks(tasks)` → danh sách gợi ý (đổi ưu tiên, gộp/tách, thứ tự trong ngày) — chỉ đề xuất.
- `parseSchedule(text)` → `CalendarEvent[]` đề xuất (mặc định `flexible`).
- `parseScheduleImage(imageDataUrl)` → `CalendarEvent[]` đề xuất; gửi ảnh dạng OpenAI multimodal
  (`content:[{type:'text'},{type:'image_url',image_url:{url}}]`); mặc định `lockKind:'fixed'` (thời khoá
  biểu cố định). Nếu model không trả gì hợp lệ → throw; bridge phân loại `no-vision` khi lỗi gợi ý thiếu
  năng lực ảnh.
- `optimizeSchedule({ events, tasks, weather })` → `{ proposed: CalendarEvent[]; rationale: string[] }`;
  **giữ nguyên** mọi event `fixed`, chỉ sắp xếp `flexible` vào khoảng trống. Prompt nhồi 5 yếu tố
  (khoa học/thời gian/địa điểm/thời tiết/mức cần thiết).

#### `weatherProvider.ts`

- `getForecast(location, dayRange)` dùng Open-Meteo: (1) geocoding `geocoding-api.open-meteo.com` →
  lat/lon; (2) `api.open-meteo.com/v1/forecast` → daily/hourly. `fetch` injectable cho test.
- Degrade: thiếu location / offline / lỗi → trả `null`; `optimizeSchedule` bỏ qua yếu tố thời tiết và
  thêm dòng rationale "thời tiết không được tính".

#### `reminderScheduler.ts`

- `start()`: chạy catch-up ngay (quét mọi reminder `fireAt <= now && !firedAt && !(snoozedTo>now)` của
  mọi task chưa `done`, phát notification, set `firedAt`), rồi `setInterval` mỗi 60s lặp quét.
- DI `{ notify, now, store }`. `notify` mặc định = `showNotification` từ `notificationBridge`. Tôn trọng
  `system.notificationEnabled` (đã có sẵn trong `showNotification`).
- `snooze(taskId, reminderId, untilMs)` / `dismiss(...)` cập nhật reminder qua store.

#### `managerBridge.ts` (UI plane)

Kênh (hằng `MANAGER_CHANNELS`, renderer build invoker từ tên — không import module Node):

```
manager.get-data            → ManagerResult<ManagerData>
manager.add-task / update-task / remove-task / toggle-subtask
manager.add-note / update-note / remove-note
manager.add-event / update-event / remove-event / set-events
manager.update-settings
manager.ai-parse-tasks      (description) → ManagerResult<Task[]>
manager.ai-review-tasks     () → ManagerResult<Suggestion[]>
manager.ai-parse-schedule   (text) → ManagerResult<CalendarEvent[]>
manager.ai-parse-image      (imageDataUrl) → ManagerResult<CalendarEvent[]>  // code: no-vision
manager.ai-optimize         (range) → ManagerResult<{proposed,rationale,weatherUsed}>
manager.snooze-reminder / dismiss-reminder
```

Mọi handler bọc `safe()` (luôn resolve envelope). Tạo bằng `bridge.buildProvider` (như companyBridge).
`registerManagerBridge({ services })` đăng ký một lần ở `initAllBridges()` (Task tích hợp). Sự kiện push
`manager.data-changed` (emit `ManagerData`) để nhiều cửa sổ/agent đồng bộ — store expose `onChange`.

#### `managerWiring.ts`

`getManagerServices()` singleton lazy: dựng `managerStore` (userData dir), `managerAi` (createProviderChat),
`reminderScheduler` (notify=showNotification). Trả `{ store, ai, scheduler }` cho cả bridge và bootstrap.

### Agent plane — `process/resources/builtinMcp/managerServer.ts`

- Standalone stdio node process (mirror `imageGenServer.ts`/resource server). Nhận thư mục dữ liệu qua env
  `AIONUI_MANAGER_DATA_DIR` (mirror `RESOURCE_STATE_DIR_ENV_KEY`).
- Dựng `managerStore` trỏ vào cùng `manager-data.json` (cùng nguồn với UI plane).
- Tools (snake_case như convention built-in): `manager_list_tasks`, `manager_add_task`,
  `manager_update_task`, `manager_add_note`, `manager_list_events`, `manager_add_event`. (Đọc/ghi trực
  tiếp store; KHÔNG gọi AI để tránh vòng lặp model.)
- Hằng định danh + helper `isBuiltinManager*` thêm vào `builtinMcp/constants.ts` (mirror Resource).

### Renderer — `packages/desktop/src/renderer/pages/manager/`

Thư mục (≤ 10 children, chia tab thành module con):

```
renderer/pages/manager/
├── index.tsx                ← export ManagerPage (lazy route target)
├── ManagerPage.tsx          ← khung 3 tab (Tasks/Note/Schedule) + BridgeNotice khi chưa wire
├── useManagerStore.ts       ← hook: load data, subscribe data-changed, các action gọi bridge
├── managerBridgeClient.ts   ← rebuild invokers từ MANAGER_CHANNELS (chỉ import type)
├── managerStrings.ts         ← helpers map enum→i18n key, màu semantic theo priority/kind
├── tasks/                   ← TasksView + TaskCard + TaskEditor + AiCreateTasks + TodayPanel
├── notes/                   ← NotesView + NoteCard + NoteEditor
└── schedule/                ← ScheduleView + DayWeekGrid + EventEditor + ImportFromImage + OptimizePanel
```

- `ManagerPage` dùng Arco `Tabs`. Khi `useManagerStore` báo bridge `unavailable` (timeout) → hiện
  `BridgeNotice` thân thiện + Retry (mirror Browser/Company).
- **Tasks UI (khoa học tâm lý):** `TodayPanel` nổi bật "hôm nay/kế tiếp"; nhóm theo ngày; thu gọn việc đã
  xong; thanh tiến độ ngày; màu priority/kind qua semantic token; hiệu ứng hoàn thành tinh tế tôn trọng
  `prefers-reduced-motion`. Mỗi `TaskKind` có icon riêng (@icon-park/react: `Calendar`/`Refresh`/
  `Lightning`/`Flag`).
- **Schedule UI:** lưới ngày/tuần; event `fixed` có viền khoá + icon `Lock`, `flexible` viền thường;
  `ImportFromImage` dùng file picker ảnh → đọc base64 → `manager.ai-parse-image` → preview chỉnh sửa;
  `OptimizePanel` hiện so sánh trước/sau + rationale + nút Áp dụng/Hoàn tác.
- Gọi AI qua `useModelProviderList` để lấy model hiện tại; truyền model id xuống bridge (như Browser).

### Tích hợp nav + route

- `Router.tsx`: thêm `const Manager = React.lazy(() => import('@renderer/pages/manager'))` + route
  `/manager`.
- `Sider/index.tsx` + `SiderNav/SiderManagerEntry.tsx`: thêm entry cấp cao (mirror `SiderStudioEntry`),
  icon `@icon-park/react` `Schedule` (hoặc `ListCheckbox`), `t('manager.title')`, navigate `/manager`.
- `i18n-config.json`: thêm `"manager"` vào `modules`; tạo `locales/<lang>/manager.json` cho cả 9 ngôn ngữ
  (en-US + vi-VN đầy đủ; còn lại dịch để không cảnh báo thiếu key). Sau đó `bun run i18n:types` +
  `node scripts/check-i18n.js`.
- `initAllBridges()` (`process/bridge/index.ts`): thêm block `registerManagerBridge` (try/catch riêng,
  log `[Bridge] Manager bridge registered.`) + `scheduler.start()`.
- Đăng ký built-in MCP `managerServer` vào nơi seed các built-in MCP (mirror image-gen/resource) + thêm
  bản dựng esbuild entry `builtin-mcp-manager.js` nếu cần (theo cách resource server được build).

## Data Models

Đã nêu trong `managerTypes.ts` ở trên. File lưu: `manager-data.json` trong `userData`, shape `ManagerData`
(version 1). Ghi atomic; nạp phòng thủ. Snapshot undo cho tối ưu lịch giữ trong renderer state (bản
`events` trước khi áp dụng) — không cần file riêng.

## Error Handling

- **Bridge:** mọi kênh trả `ManagerResult` (không reject) → UI không treo. `code: 'no-model'` /
  `'no-vision'` để UI hiện gợi ý đúng (mở Settings → Model / chọn model có vision).
- **Store:** đọc file hỏng → state rỗng + cảnh báo log; ghi lỗi → throw lên bridge (envelope hoá).
- **AI:** model trả JSON sai → throw "định dạng không hợp lệ", UI cho thử lại, giữ input.
- **Weather:** mọi lỗi → `null`, bỏ qua yếu tố thời tiết, ghi rõ trong rationale.
- **Reminder:** notification tắt trong Settings → `showNotification` tự no-op (đã có).
- **Bridge chưa wire:** invoker bọc timeout (mirror `companyBridgeClient`/`browserBridgeClient`) → UI hiện
  BridgeNotice + Retry.

## Testing Strategy

Vitest 4, đặt ở `tests/unit/manager/**` (vitest chỉ quét `tests/`), alias `@/process/...`.

- `managerStore`: CRUD, atomic persist (in-memory fs), nạp phòng thủ (file hỏng/thiếu trường), sinh lần kế
  cho recurring.
- `managerAi`: parse tasks/schedule (mock AgentChat trả JSON), optimize **giữ nguyên fixed** (bất biến
  chính — property test), parse image gọi multimodal đúng shape.
- `weatherProvider`: degrade khi fetch lỗi/thiếu location (mock fetch).
- `reminderScheduler`: catch-up phát đúng reminder quá hạn, không phát lại (mock clock + notify), snooze.
- Renderer DOM test (`*.dom.test.tsx`, project `dom`): `ManagerPage` render 3 tab; tạo task thủ công;
  toggle done cập nhật tiến độ; BridgeNotice khi bridge lỗi; Schedule phân biệt fixed/flexible.
- UI thật: theo `.kiro/steering/claude-ui-testing.md` (computer-use) — đánh dấu task riêng, có thể DEFER
  như các epic trước nếu computer-use/router không phản hồi.

## Correctness Properties

Các bất biến (invariant) phải luôn đúng, dùng làm cơ sở cho property test:

### Property 1: Lịch cứng bất khả xâm phạm

Sau `optimizeSchedule`, mọi event có `lockKind === 'fixed'` PHẢI giữ nguyên `startAt`/`endAt`/`id` (không
dời, rút ngắn, xoá). Chỉ event `flexible` được thay đổi.

**Validates: Requirements 7.2, 8.2**

### Property 2: Ghi đĩa an toàn (round-trip)

`managerStore` luôn ghi qua tmp→rename; một lần đọc sau bất kỳ chuỗi mutator nào PHẢI trả về đúng state
cuối, và một process kill giữa chừng không để lại file hỏng.

**Validates: Requirements 9.2, 1.6, 5.5, 6.11**

### Property 3: Nạp phòng thủ

Với bất kỳ JSON đầu vào nào (kể cả hỏng/thiếu trường), `load()` PHẢI trả một `ManagerData` hợp lệ (không
throw), giữ lại các bản ghi đúng shape và bỏ bản sai.

**Validates: Requirements 1.7, 5.5, 6.11**

### Property 4: Đề xuất không tự ghi

Các hàm AI (`parseTasks`/`parseSchedule`/`parseScheduleImage`/`optimizeSchedule`) KHÔNG được sửa store;
chỉ trả đề xuất. Store chỉ đổi qua mutator do người dùng gọi.

**Validates: Requirements 2.2, 3.5, 6.7, 8.5**

### Property 5: Nhắc nhở không phát lại

Một reminder đã `firedAt != null` KHÔNG được phát lại; catch-up chỉ phát các reminder tới hạn chưa phát và
không đang snooze.

**Validates: Requirements 3.2, 3.3, 3.6**

### Property 6: AI nặng đi qua lease

Mọi lời gọi AI nặng (parse ảnh, optimize) PHẢI `requestLease`/`releaseLease` cân bằng (release cả khi lỗi
— finally).

**Validates: Requirements 2.6, 8.7**

## Phụ thuộc đã chốt

- **Nhắc nhở:** tự lập lịch trong Main process (`reminderScheduler`), **không** dùng cron aioncore → không
  đụng backend. Catch-up xử lý nhắc quá hạn khi app tắt.
- **Thời tiết:** **Open-Meteo** (miễn phí, không cần khoá API), có thể tắt trong `ManagerSettings`. Degrade
  an toàn khi offline/lỗi/thiếu địa điểm.
- **Vision:** dùng đúng model người dùng đã chọn (multimodal pass-through như `webAgentRunner`); model
  không hỗ trợ ảnh → `code:'no-vision'` + gợi ý đổi model.
