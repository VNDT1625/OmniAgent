# MusicDAW

App desktop làm nhạc (kiểu BandLab) cho người dùng trực tiếp. Chưa có agent ở giai đoạn này.

## Quyết định kiến trúc (đã chốt)

- **Base sản phẩm**: fork [`brandongregoryscott/beets`](https://github.com/brandongregoryscott/beets) — **Apache-2.0** (đã verify), cho phép dùng thương mại + đóng nguồn.
- **Realtime audio**: Web Audio + Tone.js ở **renderer**.
- **Heavy/offline DSP**: **Rust sidecar** (export, stems, pitch analysis, vocal tune bản nặng).
- **Lưu trữ**: file cục bộ (thay toàn bộ Supabase của beets). 1 project = 1 thư mục `<Name>.daw/`.
- **Vocal tune MVP**: làm ở renderer theo cách autotone (CREPE/TF.js + WASM FT-shift), nâng lên Rust sau.

### Vì sao không nhúng các repo khác

| Repo            | License (verify)         | Vai trò                                                      |
| --------------- | ------------------------ | ------------------------------------------------------------ |
| beets           | Apache-2.0               | Fork base MVP (gỡ Supabase)                                  |
| openDAW         | AGPLv3 + dual commercial | Học kiến trúc (nhúng closed-source ⇒ mua commercial license) |
| autotone        | Không có LICENSE         | Tham khảo thuật toán vocal tune trên web (CREPE + WASM)      |
| stargate        | GPLv3, native Python+C   | Chỉ học ý tưởng (routing/mixer/sidechain)                    |
| ai-music/webdaw | (P1)                     | Tham khảo plugin Web Audio Modules                           |

## Trạng thái hiện tại

Đã scaffold **Phase 0–1 (phần nền)**: lớp dữ liệu project cục bộ thay thế Supabase.

- `src/shared/schema.ts` — ProjectSchema v1 (nguồn chân lý). Pure types, không Node/DOM.
- `src/shared/factory.ts` — tạo project/track/clip/effect/sample với default hợp lý.
- `src/shared/validate.ts` — validate cấu trúc project (dependency-free).
- `src/shared/migrate.ts` — migration forward-only theo `schemaVersion`.
- `src/shared/projectRepo.ts` — interface ProjectRepo (seam thay Supabase).
- `src/main/fileProjectRepo.ts` — cài đặt ProjectRepo bằng `node:fs` (Electron main). Atomic save, import sample.

## Layout dự kiến (đầy đủ)

```
src/
  main/      # Electron main: windows, ipc, spawn sidecar, fileProjectRepo
  preload/   # typed IPC bridge
  renderer/
    engine/  # transport, trackGraph, sampler, recorder, exporter
    tune/    # crepe (TF.js), ftShift wasm, tuneClip
    state/   # projectStore (jotai), schema, migrate
    pages/   # arrange, pianoRoll, stepSeq, mixer, samples
  shared/    # schema/types dùng chung main+renderer
sidecar-rs/  # crate Rust: export.rs, tune.rs, analyze.rs
```

## Verify

Dự án này hiện đang nằm **lồng trong monorepo Omni** (cũng dùng Vitest 4 với `projects:`),
nên chạy `vitest` trực tiếp bị xung đột instance/config của parent. Vì vậy có thêm
một smoke verifier độc lập (chỉ dùng `node:assert`, chạy bằng bun):

```bash
bun run src/verify.ts      # 15 checks: schema/factory/validate/migrate/repo
bunx tsc --noEmit -p tsconfig.json
```

Khi tách `musicdaw` thành repo độc lập (`git init` riêng, ra ngoài Omni), các file
`*.test.ts` (Vitest) sẽ chạy bình thường bằng `npm test` / `bun run test`.

## Roadmap theo phase (mỗi phase có "cổng usable")

- **P0** Spike vỏ Electron + phát 1 pattern. ✅ nền dữ liệu xong
- **P1** Cắt cloud, chạy 100% offline (file cục bộ). ◧ đang làm (lõi xong)
- **P2** Lõi tạo nhạc: step seq + piano roll + sampler + arrange + transport
- **P3** Thu âm mic
- **P4** Mixing (vol/pan/mute/solo + insert FX)
- **P5** Export WAV/MP3/stems (renderer `OfflineAudioContext`)
- **P6** Rust sidecar (export chất lượng cao + analyze.pitch)
- **P7** Vocal tuning theo key
- **P8** Polish (undo/redo, autosave, perf, tùy chọn refactor UI sang Arco)
