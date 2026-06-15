# Design — Smart Terminal (docTerminal + Smart Fix)

## Summary

Hai năng lực gắn vào Terminal manager có sẵn, tái dùng tối đa hạ tầng (shell integration markers, RTK,
Embedder). KHÔNG sửa aioncore. Backend = Main-process TS thuần; UI = renderer (Arco + UnoCSS + i18n).

## Vị trí code

```text
packages/desktop/src/process/terminal/commandDoc/
  commandTypes.ts        # PURE: CommandRecord, CommandSuggestion, scoring weights
  commandRedact.ts       # PURE: che secret trong lệnh trước khi lưu
  commandScore.ts        # PURE: prefixMatch + frequency + recency (+ vectorSim) → rank
  commandClassify.ts     # PURE: tách program + args (cho smart-fix)
  commandDocStore.ts     # persist commandDoc.json (atomic, fs DI)
  commandDocService.ts   # facade: capture(command,exitCode,cwd,shell) + suggest(prefix) + topK
  commandDocBridge.ts    # kênh terminal.cmd-* (capture/suggest) cho renderer
```

Smart-fix:

```text
process/terminal/smartFix/
  commandRemap.ts        # PURE: từ program + RTK facts → replacement + updateUrl
  smartFixService.ts     # dùng rtkService.lookup(topic 'cmd.remap.<program>') + commandClassify
```

Renderer:

```text
renderer/pages/terminal/components/GhostSuggestion.tsx   # overlay ghost-text trên dòng lệnh
renderer/pages/terminal/components/SmartFixNotice.tsx    # notice lỗi + remap + nút "Run với <new>"
renderer/pages/terminal/useCommandDoc.ts                 # state: theo dõi dòng đang gõ, gọi suggest, Tab-accept
renderer/pages/terminal/useSmartFix.ts                   # nghe command-end≠0 → tra remap → notice
```

## Luồng (a) — gợi ý lệnh

```text
TerminalView nhận onData → tokenizeShellIntegration → events
  command-line + command-end(exitCode=0) → commandDocService.capture()  (FR2)
user gõ giữa prompt-end..command-start → theo dõi line buffer (keydown trước khi vào pty)
  → commandDocService.suggest(prefix) → top-1 ghost-text mờ (FR5)
  → Tab → write phần còn lại vào pty
```

Theo dõi dòng đang gõ: TerminalView chặn `onKey`/`onData` của xterm input; ghép thành `lineBuffer`
(xử lý backspace, Enter reset). Khi có suggestion top-1 mà `lineBuffer` là tiền tố của nó → hiện phần
đuôi mờ tại vị trí con trỏ (overlay tuyệt đối, pointer-events-none). Tab → `writeSession(id, tail)`.

## Luồng (b) — smart fix

```text
command-end(exitCode≠0) cho command-line C
  program = commandClassify(C).program
  remap = smartFixService.lookup(program)   // RTK fact topic `cmd.remap.<program>` hoặc bảng built-in seed
  nếu có remap:
    SmartFixNotice: dòng1 = errorSummary(C, exitCode); dòng2 = "<old> updated → <new>" + link
    nút "Run với <new>": writeSession(id, C.replace(program, new))   // mặc định cần bấm
    (tuỳ chọn autoRerun bật → tự write; vẫn lỗi → hiện lỗi cụ thể)
```

errorSummary: lấy vài dòng output cuối của session giữa command-start..command-end (đã có trong buffer).

## Scoring (commandScore.ts, PURE)

```text
prefixScore  = lineBuffer rỗng ? 0.0 : (command.startsWith(lineBuffer) ? 1 : fuzzy(lineBuffer,command))
freqScore    = min(1, count / FREQ_CAP)
recencyScore = exp(-ageMs / HALF_LIFE)         // gần đây hơn → cao hơn
vectorScore  = cosine(embed(lineBuffer), embed(command))   // lớp phụ, optional
score = 0.45*prefixScore + 0.25*freqScore + 0.20*recencyScore + 0.10*vectorScore
```

Top-1 cho ghost-text yêu cầu `command.startsWith(lineBuffer)` (ghost chỉ nối đuôi hợp lệ). Top-K cho
danh sách dropdown có thể dùng cả fuzzy/vector.

## RTK integration cho remap

Remap lưu trong RTK như fact: `topic = cmd.remap.<program>`, `value = <newProgram>`, `sources` =
trang cập nhật, `volatilityClass='spec_api'`. `smartFixService` gọi `rtkService.lookup("<program> cli replacement")`
hoặc `byTopic`. Có **bảng seed built-in** nhỏ (vd `gemini→agi`) để hoạt động ngay cả khi RTK rỗng; RTK
cho phép mở rộng/làm tươi từ web qua `rtk_record`.

## An toàn (FR8)

- `commandRedact`: regex che giá trị sau `--token=/--password=/--api-key=/api_key=/-p ` v.v. trước khi lưu.
- Auto-rerun mặc định TẮT (chỉ gợi ý + 1-click). Tuỳ chọn trong Settings › Terminal.
- Ghost-text/notice: Arco + UnoCSS token, i18n, reduced-motion.

## Phasing

- **Phase 1 (backend pure):** commandTypes/redact/score/classify + commandDocStore + commandDocService + test.
- **Phase 2 (capture + suggest bridge):** commandDocBridge + wire; renderer capture trên success.
- **Phase 3 (ghost-text UI):** GhostSuggestion + useCommandDoc + Tab-accept trong TerminalView.
- **Phase 4 (smart-fix):** commandRemap + smartFixService (RTK + seed) + SmartFixNotice + useSmartFix.
- **Phase 5 (i18n + settings + tests):** module i18n 9 locale, tuỳ chọn autoRerun, DOM test.
