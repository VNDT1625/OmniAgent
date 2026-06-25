# PRD — Feature Packs (Modular AionUi)

> **Trạng thái:** ĐÃ CHỐT NGUYÊN TẮC, **HOÃN TRIỂN KHAI** đến khi các tính năng
> chính của app ổn định (gần ra mắt v3). Tài liệu này lưu lại quyết định và kế
> hoạch để khi quay lại không phải nghĩ từ đầu.
> **Tác giả:** AionUi team. **Ngày tạo:** 2026-06-01.

## 1. Bối cảnh & vấn đề

AionUi đang gộp nhiều "ứng dụng con" trong một app Electron: Chat (lõi),
Browser nhúng + web-agent, Studio (Universal Editor + Make Video + Automation +
IDE Repo Intelligence + IDE Understand), Manager (Tasks/Notes/Schedule),
Testing đa nền tảng, Bug Monitor, Agent Company, Pet, v.v.

Mỗi tính năng kéo theo phụ thuộc nặng riêng (ví dụ Browser cần `yt-dlp`,
`ffmpeg`; Studio cần ONLYOFFICE Document Server; IDE cần `web-tree-sitter` +
data file lớn; Make Video có thể cần model image-gen). Đóng gói tất cả vào
một installer làm app **rất nặng** dù phần lớn user chỉ dùng vài tính năng.

## 2. Mục tiêu

- Installer **gọn**: chỉ chứa lõi (Chat + aioncore + cấu hình + i18n + UI khung).
- Mỗi tính năng lớn = một **feature pack** tải về theo yêu cầu, kiểu update nhỏ.
- Người dùng vào tính năng chưa cài → modal "Tải gói X (~Y MB)" → tải xong dùng được.
- Mỗi pack **độc lập về phiên bản**, **cập nhật riêng**, **gỡ được**.
- App mở dù không có pack nào — chế độ Chat thuần vẫn chạy bình thường.

## 3. Phi mục tiêu (giai đoạn này)

- KHÔNG xây dựng "marketplace" cho pack do bên thứ ba publish (chỉ pack chính
  chủ AionUi, ký số). Mở cho cộng đồng là việc rất khác và cho sau.
- KHÔNG hỗ trợ tải pack từ network nội bộ doanh nghiệp (offline mirror) ở
  giai đoạn đầu — sẽ thêm khi có nhu cầu thật.
- KHÔNG đụng aioncore (Rust backend): aioncore vẫn bundle như hiện tại.

## 4. User stories (rút gọn)

- **U1** — Là user mới, tôi tải installer ~80 MB (thay vì ~250 MB), cài nhanh,
  vào ngay được Chat.
- **U2** — Khi vào Settings → Browser, tôi thấy modal "Tải gói Trình duyệt
  (~25 MB, gồm yt-dlp + ffmpeg)". Bấm tải, có progress bar, xong thì Browser
  bật lên ngay không cần restart.
- **U3** — Settings → Tính năng cho phép tôi xem mọi pack đã cài, dung lượng,
  bật/tắt auto-update, gỡ pack không dùng để giải phóng đĩa.
- **U4** — Tôi đang dùng app v2.x. Update lên v3.x → app phát hiện tôi đang
  dùng Browser/Studio/Manager → tự tải lại các pack đó **ở nền** rồi báo
  "Tính năng đã sẵn sàng", không gián đoạn.
- **U5** — Mất mạng → tính năng đã cài vẫn dùng được; tính năng chưa cài hiện
  thông báo "Cần kết nối để tải".
- **U6** — Pack có lỗ hổng/lỗi → AionUi đẩy pack mới, app phát hiện auto-update
  trong nền (theo channel `stable`/`beta` user chọn).

## 5. Yêu cầu chức năng

### 5.1 Pack registry & manifest

- Mỗi pack có manifest JSON ký số, gồm: `id`, `version`, `appCompat` (semver
  range của app), `os/arch`, `sizeBytes`, `sha256`, `urls[]` (HTTPS), `dependsOn[]`,
  `includes[]` (binary, code bundle, asset, locale), `signature`.
- Manifest registry tổng đặt ở GitHub Releases của AionUi (URL bất biến qua
  config app), tải về cache trong `userData/packs/registry.json`.

### 5.2 Cài / cập nhật / gỡ

- Cài: tải file ZIP/tar từ `urls[]`, verify `sha256` + `signature` (Ed25519),
  giải nén vào `userData/packs/<id>/<version>/`, cập nhật `installed.json`.
- Cập nhật: tải bản mới song song, swap atomically, rollback được.
- Gỡ: xoá thư mục version, cập nhật `installed.json`. Pack có dependent → cảnh
  báo trước khi gỡ.
- Mọi thao tác có lease ResourceCoordinator (`pack-io`) để không cạnh tranh
  tài nguyên với agent đang chạy.

### 5.3 Lazy load ở runtime

- **Main process**: thay vì `import './browser'` ngay, `process/index.ts` chỉ
  đăng ký bridge core (Chat + Settings + Pack manager). Khi user vào tính năng
  → pack manager kiểm tra cài chưa → `import` động bundle pack vào, gọi hàm
  `register*()` của pack đó.
- **Renderer**: `Router.tsx` dùng `lazy()` cho mọi feature route; route chưa
  có pack → render `FeatureGate` (giới thiệu + nút Tải).
- i18n module mỗi feature đi kèm pack, register động qua `i18n.addResourceBundle`.

### 5.4 UX

- Settings → **Tính năng** (tab mới): danh sách pack (đã cài / có thể cài /
  cần update), dung lượng, mô tả, hình ảnh.
- Pack chưa cài: vào route → `FeatureGate` (Arco) với mô tả tính năng + ảnh
  preview + nút "Tải gói" + ước lượng dung lượng + thời gian.
- Tiến trình tải: dock toast (Arco Notification) có thể minimize, không chặn UI.

### 5.5 Bảo mật

- Mọi pack ký Ed25519 bằng key của AionUi (private key trong CI secrets).
- Public key embed cứng vào app — không tải từ mạng.
- App từ chối pack signature sai / không có signature.
- HTTPS bắt buộc; reject HTTP/file://.
- App từ chối pack có `appCompat` không khớp app version.
- Không cho phép pack thực thi code Node tuỳ ý ngoài bộ API định sẵn (Pack
  exposes named exports: `registerBridges()`, `registerRoutes()`, `i18nResources`).

### 5.6 Migration (v2.x → v3.x modular)

- Lần đầu chạy v3.x trên user v2.x: đọc usage cũ (file config v2 đã có
  `recently used features`) → seed danh sách pack cần auto-install.
- Tải nền + thông báo "Tính năng X đã sẵn sàng".
- Có thể tắt auto-install trong Onboarding lần đầu.

## 6. Yêu cầu phi chức năng

- **Hiệu năng**: lazy-load thêm <200 ms khi vào tính năng đã cài (overhead
  parse manifest + dynamic import).
- **Kích thước installer lõi**: mục tiêu <100 MB (hiện ~250 MB ước tính).
- **Tải pack**: tốc độ giới hạn theo băng thông user, có thể pause/resume,
  retry với exponential backoff.
- **Toàn vẹn**: kiểm tra sha256 + signature; pack hỏng → tự xoá + tải lại.
- **Privacy**: không gửi telemetry usage pack ra ngoài (trừ khi user opt-in).

## 7. Kiến trúc tóm tắt

```
┌────────────────────── App lõi (installer) ──────────────────────┐
│  Electron shell + aioncore + Chat + Settings + Pack Manager UI  │
│                                                                 │
│  process/services/packManager/                                  │
│    ├── registry.ts    — fetch manifest, verify, cache           │
│    ├── installer.ts   — download/verify/extract/rollback        │
│    ├── runtime.ts     — load pack on demand, expose lifecycle    │
│    ├── signature.ts   — Ed25519 verify                          │
│    └── store.ts       — installed.json + state                  │
└────────────────────────┬────────────────────────────────────────┘
                         │ tải/cập nhật pack
                         ▼
              userData/packs/<packId>/<version>/
                ├── manifest.json
                ├── main.js          (CommonJS bundle, Main process)
                ├── renderer.js      (ESM bundle, lazy-loaded)
                ├── locales/*.json
                └── assets/          (binary: yt-dlp.exe, ffmpeg, …)
```

Mỗi pack export hợp đồng cố định:

```ts
// main.js (Main process)
export function registerPack(ctx: PackContext): void {
  ctx.registerBridge('browser.*', registerBrowserBridge);
  ctx.registerMcp('browser-control', createBrowserControlServer);
  ctx.registerAssetResolver('yt-dlp', () => path.join(ctx.assetsDir, 'yt-dlp.exe'));
}

// renderer.js (Renderer)
export const routes = [...];
export const i18nResources = { 'vi-VN': {...}, 'en-US': {...} };
export const settingsTabs = [...];
```

## 8. Lộ trình triển khai (3 giai đoạn)

### Giai đoạn 1 — Asset pack (1–2 ngày)

**Mục tiêu**: chứng minh được mô hình download/verify/install pack hoạt động,
trên scope nhỏ, không refactor code.

- Phạm vi: pack `browser-assets` chứa `yt-dlp.exe` + `ffmpeg.exe`.
- Code Browser vẫn nằm trong app như cũ; pack chỉ chứa **binary**.
- Khi vào Browser → modal "Tải gói trình duyệt nâng cao".
- Pack tải về `userData/packs/browser-assets/<v>/`, `externalTools.ts` thêm
  thư mục đó vào danh sách dò.
- Hosting: GitHub Releases (`browser-assets-vX.Y.Z-win-x64.zip`, signature đi kèm).
- **Deliverable**: `process/services/packManager/` (mvp), `FeatureGate.tsx`,
  Settings → Tính năng (tab cơ bản).

### Giai đoạn 2 — Code pack thử nghiệm (1 tuần)

**Mục tiêu**: tách MỘT feature ra code pack thật để xác nhận lazy-load + bundle

- contract `registerPack` ổn.

* Chọn feature ít liên kết với Chat — đề xuất **Testing** hoặc **Make Video**.
* electron-vite cấu hình để build feature đó thành bundle riêng (CommonJS Main
  - ESM Renderer), không đóng vào installer chính.
* Renderer route lazy + `FeatureGate`.
* Migration test: cài app, không có pack → app bình thường, không lỗi import.

### Giai đoạn 3 — Modular hoá toàn bộ (2–3 tuần, trải dài)

- Tách dần các feature lớn thành pack: Browser, Studio, Manager, Bug Monitor,
  Company, IDE.
- Settings → Tính năng UI hoàn chỉnh (đã cài / có thể cài / cần update / gỡ).
- Auto-update từng pack (background, channel `stable`/`beta`).
- Migration v2.x → v3.x: đọc config cũ → tự seed pack cần cài.
- Documentation người dùng (FAQ, privacy, troubleshoot).

## 9. Đánh đổi đã thảo luận với người dùng

| Vấn đề                                                             | Quyết định                                              |
| ------------------------------------------------------------------ | ------------------------------------------------------- |
| Tốn thời gian dev (~3–4 tuần tổng)                                 | Chấp nhận. Làm CUỐI khi feature đã ổn định.             |
| Hosting & băng thông                                               | GitHub Releases miễn phí (CDN tốt).                     |
| Migration user v2.x                                                | Bắt buộc làm cẩn thận. Có user-story U4.                |
| Tốc độ phát triển sau này (mỗi PR tính năng đụng manifest/version) | Chấp nhận, đổi lấy installer gọn + UX tốt.              |
| Marketplace bên thứ ba                                             | KHÔNG làm giai đoạn này. Chỉ pack chính chủ.            |
| Tính năng chưa cài → trang giới thiệu vs ẩn hoàn toàn              | Hiển thị `FeatureGate`, KHÔNG ẩn — user biết app có gì. |

## 10. Rủi ro & cách giảm

- **Rủi ro: pack "treo" khi tải lúc agent đang chạy nặng** → dùng lease
  ResourceCoordinator `pack-io`, queue sau.
- **Rủi ro: pack bản mới làm crash app** → mỗi pack có version + rollback;
  app crash 2 lần liên tiếp khi load pack X → tự rollback về version cũ.
- **Rủi ro: signature key bị lộ** → embed nhiều public key (key rotation),
  có cơ chế revoke.
- **Rủi ro: GitHub Releases rate limit** → CDN cache tự nhiên + retry; nếu
  cần thêm Cloudflare R2 (chi phí thấp).
- **Rủi ro: i18n thiếu key khi pack chưa cài** → mọi key core phải nằm ở
  installer lõi; pack chỉ thêm key của riêng nó.

## 11. Bước tiếp theo khi quay lại làm

Khi sẵn sàng triển khai, đọc lại file này rồi:

1. Tạo spec chính thức ở `.kiro/specs/feature-packs/` (`requirements.md` +
   `design.md` + `tasks.md`) bám theo lộ trình mục 8.
2. Bắt đầu Giai đoạn 1 (asset pack `browser-assets` cho yt-dlp + ffmpeg) —
   có thể làm độc lập mà không refactor app.
3. Đánh giá Giai đoạn 2 sau khi G1 ổn định 1–2 tuần thực tế (bug, feedback).
4. Giai đoạn 3 dàn trải, chỉ bắt đầu khi feature lớn đã ổn định để tránh
   rework.

## 12. Liên kết

- Hướng dẫn codebase: [`docs/CODEBASE_GUIDE.md`](../../CODEBASE_GUIDE.md)
- Trạng thái đang chạy: [`.kiro/status.md`](../../../.kiro/status.md)
- aioncore bundling pattern (tham khảo): `packages/desktop/src/process/backend/binaryResolver.ts`
- Service trích xuất nội dung (sẽ được pack hoá ở G3): `packages/desktop/src/process/services/contentExtract/`
