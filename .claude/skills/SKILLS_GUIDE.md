# Skills Guide — đọc đầu mỗi session

Hướng dẫn dùng skill cho dự án AionUi/Tomni Agentic. **Đầu mỗi session, đọc file này** để biết
có skill nào, khi nào dùng, path ở đâu, và cách tránh xung đột.

- **Path skill (workspace):** `.claude/skills/<tên-skill>/SKILL.md`
- **Path skill (user-level, nếu có):** `~/.kiro/skills/<tên-skill>/SKILL.md`
- Quy ước: mỗi skill có `SKILL.md`; một số kèm file phụ (references) trong cùng thư mục.
- Khi một skill được kích hoạt, **báo ở đầu** theo dòng "Announce at start" của skill đó.

## Khi nào dùng skill nào (trigger → skill)

| Tình huống                                                         | Skill                                                                                                                        | Path                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Tạo/sửa/làm đẹp UI (page, panel, component, modal)                 | **frontend-design**                                                                                                          | `.claude/skills/frontend-design/SKILL.md`      |
| Tạo file/module mới, quyết định đặt code ở đâu, cấu trúc thư mục   | **architecture**                                                                                                             | `.claude/skills/architecture/SKILL.md`         |
| Thêm/sửa chuỗi hiển thị, locale, module i18n                       | **i18n**                                                                                                                     | `.claude/skills/i18n/SKILL.md`                 |
| Viết/chạy test, trước khi báo "xong"                               | **testing**                                                                                                                  | `.claude/skills/testing/SKILL.md`              |
| Gặp bug/test fail/hành vi lạ — TRƯỚC khi đề xuất fix               | **systematic-debugging**                                                                                                     | `.claude/skills/systematic-debugging/SKILL.md` |
| App lag, ngốn RAM/CPU/GPU, khởi động chậm, chỉnh concurrency/lease | **performance**                                                                                                              | `.claude/skills/performance/SKILL.md`          |
| Test UI thật end-to-end                                            | ⛔ KHÔNG dùng Claude/computer-use (xem `.kiro/steering/claude-ui-testing.md`) — dùng Vitest/DOM + `bun start` cho người dùng | —                                              |
| Tự sửa bug từ GitHub issue (workflow: issue → fix → PR)            | **fix-issues**                                                                                                               | `.claude/skills/fix-issues/SKILL.md`           |
| Tự sửa lỗi tần suất cao từ Sentry                                  | **fix-sentry**                                                                                                               | `.claude/skills/fix-sentry/SKILL.md`           |
| Commit + tạo pull request                                          | **oss-pr**                                                                                                                   | `.claude/skills/oss-pr/SKILL.md`               |
| Review một PR (local, full context)                                | **pr-review**                                                                                                                | `.claude/skills/pr-review/SKILL.md`            |
| Sửa hết issue từ báo cáo pr-review                                 | **pr-fix**                                                                                                                   | `.claude/skills/pr-fix/SKILL.md`               |
| Verify + merge PR đã `bot:ready-to-merge`                          | **pr-verify**                                                                                                                | `.claude/skills/pr-verify/SKILL.md`            |
| Toàn vòng đời PR (tạo → CI → review → fix → merge)                 | **pr-ship**                                                                                                                  | `.claude/skills/pr-ship/SKILL.md`              |
| Tự động hóa PR theo daemon/label state machine                     | **pr-automation**                                                                                                            | `.claude/skills/pr-automation/SKILL.md`        |
| Bump version + release                                             | **bump-version**                                                                                                             | `.claude/skills/bump-version/SKILL.md`         |

## Nhóm chức năng (để chọn nhanh)

- **Code & cấu trúc:** architecture, frontend-design, i18n, performance
- **Chất lượng:** testing, systematic-debugging _(test-with-computer ⛔ DEPRECATED — không dùng Claude/computer-use, xem `.kiro/steering/claude-ui-testing.md`)_
- **Sửa lỗi tự động:** fix-issues (GitHub), fix-sentry (Sentry)
- **PR & release:** oss-pr, pr-review, pr-fix, pr-verify, pr-ship, pr-automation, bump-version

## Tránh xung đột (QUAN TRỌNG)

Nhiều skill có vùng chồng lấn. Quy tắc phân định để không gọi nhầm hoặc gọi chồng:

1. **Debug vs Fix tự động.**
   - `systematic-debugging` = _phương pháp tư duy_ tìm root cause cho BẤT KỲ bug nào (dùng nội bộ, không tạo PR). Luôn dùng đầu tiên khi gặp lỗi.
   - `fix-issues` / `fix-sentry` = _workflow tự động_ lấy bug từ GitHub/Sentry → sửa → PR. Bên trong vẫn nên áp phương pháp của `systematic-debugging`.
   - → Lỗi đang code: dùng `systematic-debugging`. Lỗi từ issue tracker/Sentry: dùng `fix-issues`/`fix-sentry`.

2. **PR workflows — chỉ dùng MỘT cho mỗi mục tiêu, không chồng:**
   - Chỉ commit + mở PR → `oss-pr`.
   - Chỉ review → `pr-review`. Sửa theo report review → `pr-fix`.
   - Verify + merge PR đã sẵn sàng → `pr-verify`.
   - Muốn làm trọn vòng một phát → `pr-ship` (nó tự gọi create/review/fix/merge — **đừng** gọi thêm các skill PR khác song song).
   - Daemon tự động nhiều PR → `pr-automation` (đừng chạy thủ công song song với nó).
   - → Tránh: gọi `pr-ship` rồi lại gọi `oss-pr`/`pr-review` cùng lúc — gây tạo PR/branch trùng.

3. **performance vs systematic-debugging.** Lag/leak: `systematic-debugging` để tìm nguyên nhân, rồi `performance` để tối ưu có đo đạc. Đừng tối ưu mù khi chưa biết process nào nóng.

4. **frontend-design KHÔNG ghi đè luật stack.** Lấy nguyên tắc thẩm mỹ, nhưng render bằng Arco + UnoCSS + i18n (xem "Project Stack Binding" trong skill). Không Tailwind/shadcn/raw HTML.

5. **i18n đi kèm mọi UI.** Khi `frontend-design` tạo UI có chữ → kích hoạt `i18n` để đặt key, đừng hardcode.

6. **Một hành động "nặng" mỗi lượt với nhóm PR-automation** (theo thiết kế của chính skill) — không ép chạy nhiều bước merge trong một lượt.

## Có nên bổ sung skill nào nữa không? (đánh giá hiện tại)

Bộ skill hiện tại đã phủ: UI, kiến trúc, i18n, test, debug, performance, sửa lỗi tự động, PR, release.
Trước khi thêm skill mới, kiểm tra theo checklist để **không gây trùng/xung đột**:

- [ ] Chức năng này đã có skill nào phủ chưa? (xem bảng trên) — nếu có, KHÔNG thêm.
- [ ] Skill mới có khớp stack dự án không? (Electron + React 19 + Arco + UnoCSS + aioncore Rust)
  - Cảnh báo: skill **backend generic** (Express/NestJS/Postgres/nginx) và skill **UI Tailwind/shadcn** thường XUNG ĐỘT với luật dự án — tránh.
- [ ] Skill có nguồn rõ ràng + license + nhiều sao/được duy trì không?
- [ ] Tải **verbatim** (giữ `LICENSE`), nếu cần thích ứng thì thêm mục "Project Binding" trong chính SKILL.md, ghi rõ nguồn.
- [ ] Đăng ký vào `AGENTS.md` (Skills Index) **và** cập nhật file này.

**Ứng viên có thể cân nhắc sau (chỉ khi thật sự cần, chưa thêm vội):**

- Skill review bảo mật (security audit) cho code xử lý file/mạng — hiện `pr-review` đã phủ một phần.
- Skill tài liệu/changelog — `bump-version` đã sinh CHANGELOG, nên có thể không cần.
- Không khuyến nghị thêm skill backend generic vì xung đột kiến trúc aioncore.

## Quy trình thêm skill mới (chuẩn)

1. Xác nhận không trùng (checklist trên).
2. Tải verbatim về `.claude/skills/<tên>/` kèm `LICENSE`.
3. Nếu xung đột stack: thêm mục "Project Stack Binding" ngay trong SKILL.md (ghi nguồn, binding thắng).
4. Cập nhật `AGENTS.md` → bảng Skills Index.
5. Cập nhật bảng trong file này (trigger + path + ghi chú xung đột).
