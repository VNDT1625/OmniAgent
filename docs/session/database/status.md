# Status — IDE Database (handoff cho agent kế tiếp)

> Cập nhật: 2026-06-09. Phạm vi: feature **IDE Database** (client SQL đa kết nối tích hợp app,
> dùng chung UI + agent) — đã nâng lên **production-grade** + đang thêm **trực quan hóa (ER diagram + chart)**.
> File này liệt kê việc ĐÃ xong, việc CHƯA xong, và cách làm tiếp. Đọc kèm `memory.md` cùng thư mục.

## ✅ Đã xong (không cần làm lại)

### Production-grade hardening (HOÀN THIỆN, đã test)
- **Secret**: bỏ native `keytar`, chuyển password sang mã hóa tại chỗ qua Electron `safeStorage`
  (giống `gitCredentialStore`). Blob `encryptedPassword`/`osEncrypted` nằm trong `connections.json`,
  giải mã CHỈ ở Main. Edit để trống password → giữ blob cũ. Crypto seam (`DbCrypto`) inject để test.
- **Robustness**: `postgresDriver`/`mysqlDriver` dùng **connection pool** (pg.Pool / mysql2 createPool,
  max 4) + probe `SELECT 1` lúc `connect()` (giữ semantics connect-throws). Docker restart / idle drop tự reconnect.
- **Kết nối Docker/cloud**: module thuần `dbUrl.ts` (`parseDbUrl`) parse `postgres://`/`postgresql://`/
  `mysql://`/`mariadb://`/`sqlite://`/`file:`/bare path + Windows drive. UI có ô "Connection URL" dán-tự-điền.
- **Đầy đủ tính năng DB**: driver contract +`getIndexes`/`getForeignKeys`; `dbService.getTableDetail`
  (cột+index+FK 1 call); `queryScript` (tách `;` qua `splitStatements`, chạy tuần tự, dừng ở lỗi đầu).
- **Driver test được**: 3 driver nhận `ModuleLoader` inject (default `require`) → test pg/mysql bằng fake module.
- **UI**: schema tree hiện index/FK, ô lọc bảng (>8 bảng), export **CSV/JSON** (`dbExport.ts` thuần),
  editor Run chạy cả script.
- **Agent plane**: `db_describe_table` (MCP `aionui-ide`) trả cột + index + foreign key.
- **Cấu trúc**: 3 driver đã chuyển vào `process/ide/db/drivers/` (để top-level db ≤10 children).

### Backend cho trực quan hóa (ĐÃ xong, đã test) — phần móng cho ER diagram
- Type `DbSchemaGraph` + `DbSchemaGraphTable` trong `dbTypes.ts`.
- `dbService.getSchemaGraph(id, maxTables?)` — list tables → fetch cột + FK mỗi bảng (Promise.all),
  cap `DEFAULT_MAX_SCHEMA_TABLES = 60`, cờ `truncated`. Lỗi 1 bảng không làm hỏng cả graph (catch → []).
- Kênh `ide.db-schema-graph` (`dbBridge.ts`) + `dbClient.schemaGraph(id, maxTables?)` (timeout QUERY_TIMEOUT_MS).
- Test: `dbService.test.ts` "getSchemaGraph returns tables with their columns + foreign keys".

### Verify (tại thời điểm chốt)
- `tests/unit/ide/db` **40 pass / 8 skip (sqlite integration ngoài Electron ABI)**; `dbService.test.ts` 11/11.
- getDiagnostics SẠCH mọi file db (backend + drivers + client + tests).
- oxlint db 0/0 (trước khi thêm UI viz).

## 🚧 ĐANG LÀM — phần TRỰC QUAN HÓA (cập nhật 2026-06-09)

> Người dùng muốn "trực quan hóa database dễ hình dung". Backend graph đã sẵn sàng.
> **5 file UI THUẦN/COMPONENT đã được TẠO nhưng CHƯA wire vào panel/hook, CHƯA có i18n, CHƯA test.**

### ✅ Đã tạo (component/pure — đã viết, cần verify + wire)
Tất cả trong `renderer/pages/studio/ide/db/` (dir giờ **9 file** ≤10):
1. `dbSchemaLayout.ts` (PURE) — `computeSchemaLayout(graph)` → React Flow `Node[]/Edge[]`. Node id =
   `tableId(schema,name)` (`schema.name` hoặc `name`); edge = mỗi FK (resolve target theo schema-qualified
   rồi theo tên; bỏ self/ngoài-graph; dedupe cặp). Layout **masonry** (cột = √n clamp 1..6, thả vào cột thấp
   nhất → không chồng). Helper: `tableId`, `nodeHeight`, `styleSchemaEdges(edges, focusId)`,
   `computeHighlight(id, focusId, neighbors)`. Hằng số export `NODE_W=230`, `MAX_ROWS=14`.
2. `DbTableNode.tsx` — custom node `type:'dbtable'`. Header (icon TableFile + tên + tag "view") + mỗi cột 1
   dòng (icon `Key` cho PK, `Link` cho FK-source, tên + type), footer "+N" khi cột > MAX_ROWS. 2 Handle ẩn.
   Dùng key i18n **`ide.db.moreColumns`** (cần thêm — xem mục C).
3. `SchemaDiagram.tsx` — `ReactFlow` view mirror `RepoGraphView`: Background dots / Controls / MiniMap /
   fitView / `colorMode={theme}` / hover→highlight (`styleSchemaEdges`+`computeHighlight`). Props `graph: DbSchemaGraph`.
   Dùng key i18n **`ide.db.diagramEmpty`**, **`ide.db.diagramAria`** (cần thêm).
4. `dbChart.ts` (PURE) — `numericColumnIndices`, `isChartable`, `toNumber`, `buildChartSpec(result,labelIdx,valueIdx)`
   (cap `MAX_BARS=50`, labelIdx<0 = số thứ tự dòng).
5. `ResultChart.tsx` — bar chart **SVG thuần** (không chart lib), 2 Arco `Select` chọn cột nhãn/giá trị.
   Dùng key i18n **`ide.db.chartNeedsNumeric`/`chartLabelColumn`/`chartRowNumber`/`chartValueColumn`/`chartAria`** (cần thêm).

### ⬜ CÒN LẠI (làm tiếp theo thứ tự này)
1. **getDiagnostics** 5 file vừa tạo → sửa lỗi type nếu có (CHƯA chạy lần nào).
2. **`useDatabasePanel.ts`**: thêm state `schemaGraph: DbSchemaGraph | null`, `loadingGraph`, `graphError`,
   và `loadSchemaGraph()` gọi `dbClient.schemaGraph(activeId)`; reset graph khi `selectConnection`. Đưa vào
   `UseDatabasePanel` type + return object. (File đã mở sẵn; import `DbSchemaGraph` từ `./dbClient`.)
3. **`DatabasePanel.tsx`**: thêm toggle **"Query | Diagram"** ở `QueryHeader` (Arco `Radio.Group`/segmented).
   Khi Diagram → `loadSchemaGraph()` (1 lần) rồi render `<SchemaDiagram graph={db.schemaGraph} />` (loading/empty).
   Trong `ResultArea`: khi result có cột số (`isChartable`) thêm toggle **"Table | Chart"** → render `<ResultChart result={...} />`.
4. **i18n** — thêm vào block `ide.db.*` của **9 locale** (`locales/<locale>/ide.json`). Key BẮT BUỘC (các component
   trên đã gọi): `moreColumns` ("+{{n}} more"), `diagramEmpty`, `diagramAria`, `chartNeedsNumeric`,
   `chartLabelColumn`, `chartRowNumber`, `chartValueColumn`, `chartAria`. Thêm cho toggle: `viewQuery`,
   `viewDiagram`, `viewTable`, `viewChart`, `diagramLoading`. Sau đó `bun run i18n:types` + `node scripts/check-i18n.js`.
5. **Test**: `tests/unit/ide/db/dbSchemaLayout.test.ts` (id resolve, edge từ FK, masonry không chồng, highlight),
   `dbChart.test.ts` (numericColumnIndices, buildChartSpec cap, toNumber). DOM: thêm vào `DatabasePanel.dom.test.tsx`
   toggle Diagram (mock `dbClient.schemaGraph`) + Chart. Theo `claude-ui-testing.md` (Vitest + @testing-library, KHÔNG computer-use).
6. **lint/format** `bunx oxlint` + `bunx oxfmt` phạm vi db; cập nhật `CODEBASE_GUIDE.md` + `.kiro/status.md`.

### D. (Tùy chọn) Agent plane
- Có thể thêm tool MCP `db_schema_overview` trong `process/ide/mcp/ideServer.ts` (gọi `getSchemaGraph` qua
  `DbAgentService` — cần thêm method vào type đó) trả text/JSON tables+FK để agent "hình dung" schema. CHƯA làm.

### ⚠️ Giới hạn thư mục
- `renderer/.../db/` hiện **9 file** (4 cũ + 5 viz) — KHÔNG thêm file nữa, nếu cần thì gom subfolder.
- `process/ide/db/` hiện **9 children** (8 file + `drivers/`).

## 🚫 Lỗi cần lưu ý (KHÔNG thuộc DB — pre-existing)
- `bunx tsc --noEmit` toàn repo còn lỗi ở feature KHÁC tùy thời điểm: `news/MarketView`,
  `ide/components/WikiPanel.tsx` + `useRepoWiki.ts`, `utils/chat/runWorkspaceVerification.ts`,
  `experience/`, `terminal/commandDoc/`. **Không phải do DB.** Dùng `getDiagnostics` trên từng file DB
  để kiểm (luôn sạch) thay vì đọc tsc toàn repo.

## 📌 Lệnh hay dùng
- Test DB: `bun run test tests/unit/ide/db` (output mangle ở cmd → ghi `.kiro\tmp-test.txt` rồi đọc).
- i18n: `bun run i18n:types` + `node scripts/check-i18n.js`.
- Lint/format DB: `bunx oxlint packages/desktop/src/process/ide/db packages/desktop/src/renderer/pages/studio/ide/db`
  + `bunx oxfmt <dirs>`.
- App thật để NGƯỜI DÙNG tự kiểm: `bun start` → Studio › IDE › mode **Database** (icon DataSheet).
