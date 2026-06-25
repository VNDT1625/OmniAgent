# Memory — IDE Database (ghi nhớ cho agent kế tiếp)

> Thông tin cần-nhớ để tiếp tục feature **IDE Database** mà không phải dò lại. Đọc kèm `status.md`.
> Cập nhật: 2026-06-09.

## Kiến trúc & vị trí file

**Backend (Main process, Node)** — `packages/desktop/src/process/ide/db/`:
- `dbTypes.ts` — mọi type chung (DbKind, DbConnectionConfig, DbColumn/Index/ForeignKey/Table,
  DbQueryResult, DbScriptResult, **DbSchemaGraph/DbSchemaGraphTable**, DbResult envelope). KHÔNG có runtime.
- `dbDriver.ts` — contract `DbDriver` (connect/getSchema/getColumns/**getIndexes**/**getForeignKeys**/query/close)
  + helper THUẦN: `isReadOnlySql`, `splitStatements`, `normalizeCell` (dùng `Buffer` → KHÔNG import vào renderer),
  `DEFAULT_MAX_ROWS`, `DEFAULT_TIMEOUT_MS`, type `ModuleLoader<T>` (seam inject module native).
- `drivers/` — `sqliteDriver.ts` (better-sqlite3), `postgresDriver.ts` (pg.Pool), `mysqlDriver.ts`
  (mysql2 pool). Mỗi driver: `create<Engine>Driver(config, load = defaultLoad)`; `load` inject để test.
  Import nội bộ dùng `../dbDriver`, `../dbTypes` (vì nằm trong subfolder).
- `dbConnectionStore.ts` — JSON store + `DbCrypto` seam (safeStorage). `list/upsert/remove/resolve`.
  Password mã hóa trong record (`encryptedPassword`), không bao giờ plaintext ra đĩa/renderer.
- `dbService.ts` — singleton logic dùng chung 2 plane: `listConnections/saveConnection/deleteConnection/
  connect/testConnection/listTables/getColumns/getIndexes/getForeignKeys/getTableDetail/**getSchemaGraph**/
  query/**queryScript**/close/closeAll`. Mở driver lazy theo id (cache `live` Map). `DEFAULT_MAX_SCHEMA_TABLES=60`.
- `dbBridge.ts` — kênh IPC `ide.db-*` (envelope `DbResult` always-resolve qua `guard`). `DB_CHANNELS`
  có thêm `tableDetail`, `schemaGraph`, `queryScript`. Wire ở `process/bridge/index.ts` (`registerDbBridge`).
- `dbWiring.ts` — `getDbService()` singleton (safeStorage crypto + driver factory map). `disposeDbService()`.
- `dbUrl.ts` (PURE) — `parseDbUrl(raw)` → `Partial<DbConnectionConfig>|null`.
- `dbExport.ts` (PURE) — `toCsv`/`toJson` từ `DbQueryResult`.
- MCP: `process/ide/db/` KHÔNG chứa server; tool `db_*` nằm ở `process/ide/mcp/ideServer.ts`
  (`DbAgentService` = subset service; wire `getDbService()` trong `ideMcpWiring.ts`).

**Renderer (no Node API)** — `packages/desktop/src/renderer/pages/studio/ide/db/`:
- `dbClient.ts` — typed client bọc kênh `ide.db-*` + `withTimeout`. Re-export type từ `dbTypes`.
  Có `schemaGraph(id, maxTables?)`. **CHỈ import type** từ `@process/ide/db/*` (trừ `dbExport`/`dbUrl`
  THUẦN được import runtime an toàn). KHÔNG import `dbDriver` (có Buffer) vào renderer.
- `useDatabasePanel.ts` — state spine (connections/tables/result/error...). `runQuery` LUÔN dùng
  `queryScript` (1 hay nhiều câu lệnh), surface last row-returning result. `loadColumns`→`tableDetail`.
- `DbConnectionModal.tsx` — form theo engine + ô paste URL (`parseDbUrl`) + Test.
- `DatabasePanel.tsx` — rail connections + schema tree (cột/index/FK, lọc bảng) + SQL editor + result grid
  (export CSV/JSON). Mode `database` trong `IdeWorkspace` activity bar (icon DataSheet).

## Cạm bẫy QUAN TRỌNG (đã gặp trong phiên)

- **`@icon-park/react` KHÔNG có icon `Database`** → dùng `DataSheet`. Trước khi dùng icon mới, verify:
  `findstr /C:"as <Name> }" node_modules\@icon-park\react\es\map.js`. (Đã verify tồn tại: `Key`, `LinkOne`,
  `Download`, `Search`, `DataSheet`.)
- **KHÔNG import `dbDriver.ts` vào renderer** — `normalizeCell` dùng `Buffer` (Node). Nếu cần
  `splitStatements` ở renderer thì gọi backend `queryScript` thay vì split phía renderer (đã làm vậy).
- **`vi.mock` factory bị hoist** → biến tham chiếu phải dùng `vi.hoisted(() => ...)` (xem
  `DatabasePanel.dom.test.tsx`). Mock `dbClient` qua path alias `@/renderer/pages/studio/ide/db/dbClient`.
- **DOM test matcher**: text bị tách nhiều node (vd `users_pkey (id)`) → dùng `findAllByText(/regex/)`
  + `.length>0` thay vì exact string.
- **`smart_relocate` KHÔNG tự cập nhật import** trong repo này ("No import references were updated") →
  sau khi move file phải tự sửa: import nội bộ của file được move + mọi nơi import nó (kể cả test).
- **Giới hạn ≤10 children/thư mục** là lý do `drivers/` ra đời. Kiểm trước khi thêm file vào `process/ide/db/`.
- Shell = `cmd`; output hay mangle → ghi `.kiro\tmp-*.txt` rồi đọc; dọn sau.
- `bunx tsc --noEmit` toàn repo còn lỗi pre-existing ở module khác → kiểm DB bằng `getDiagnostics` từng file.

## React Flow (cho ER diagram sắp làm)
- Lib có sẵn: `@xyflow/react` (v12). Mẫu CHUẨN: `components/RepoGraphView.tsx` + `RepoGraphNode.tsx`
  + `repoGraphLayout.ts`. Nhớ: `import '@xyflow/react/dist/style.css'`, `colorMode={theme}` (`useTheme`),
  custom node cần 2 `Handle` ẩn (`isConnectable={false}`), `proOptions={{hideAttribution:true}}`,
  layout là hàm PURE memo theo graph. Palette data-viz hardcode là ngoại lệ được phép (xem `PALETTE`).
- `mermaid` cũng có sẵn (v11) nếu muốn render ER bằng text-diagram thay vì React Flow — nhưng React Flow
  tương tác tốt hơn (pan/zoom/minimap) và đồng bộ với phần còn lại của IDE.

## Lệnh
- Test 1 file: `bunx vitest run tests/unit/ide/db/<file>.test.ts`
- Cả nhóm DB: `bun run test tests/unit/ide/db`
- i18n: `bun run i18n:types` && `node scripts/check-i18n.js`
- Lint/format: `bunx oxlint <dirs>` / `bunx oxfmt <dirs>`
