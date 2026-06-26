/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Goal slash commands (`/goal`, `/goal-all`).
 *
 * These commands turn a short user requirement into a fully expanded autonomous
 * instruction that is sent to the agent. The chat bubble still shows the raw
 * `/goal ...` text the user typed (display message), while the agent receives the
 * expanded prompt below (model input). This is what makes the agent understand,
 * immediately and without reading any external file, that "goal = the objective"
 * and that it must follow the mandatory closed-loop pipeline until the goal is
 * reached (or credits run out).
 *
 * Mirror of the design documented in `.claude/commands/goal.md`, kept inline here
 * so it works as a real in-app slash command rather than a doc the agent must read.
 */

export const GOAL_COMMAND_NAME = 'goal';
export const GOAL_ALL_COMMAND_NAME = 'goal-all';

/** Matches `/goal <requirement>` or `/goal-all <requirement>` (goal-all first). */
const GOAL_COMMAND_RE = /^\/(goal-all|goal)\s+([\s\S]+)$/i;

/** Matches `/goal off`, `/goal stop`, `/goal-all off`, `/goal-all stop` (turn Goal Mode off). */
const GOAL_OFF_RE = /^\/(?:goal-all|goal)\s+(?:off|stop)\s*$/i;

/** Matches `/goal verify <command>` / `/goal verify off` (set/clear the independent verify command). */
const GOAL_VERIFY_RE = /^\/(?:goal-all|goal)\s+verify\b\s*([\s\S]*)$/i;

export type GoalCommandVariant = 'goal' | 'goal-all';

/**
 * Machine-readable status contract enforced by the renderer compliance engine.
 * The agent MUST end every turn with this marker so the renderer can gate the
 * run by code (see `goalCompliance.ts`).
 */
export const GOAL_STATUS_CONTRACT =
  'BẮT BUỘC — kết thúc MỖI lượt bằng đúng MỘT dòng trạng thái máy đọc được: [[GOAL next=continue|done|blocked tests=pass|fail|none phase=<số pha 1-9>]]. Dùng next=done CHỈ khi mọi Definition of Done đạt VÀ tests=pass; chưa xong dùng next=continue; bị chặn cứng dùng next=blocked. Thiếu dòng này lượt sẽ bị từ chối và bắt làm lại.';

export type ParsedGoalCommand = {
  variant: GoalCommandVariant;
  requirement: string;
};

/** Whether the input deactivates Goal Mode (`/goal off` / `/goal stop`). */
export const isGoalOffCommand = (input: string): boolean => {
  if (!input) return false;
  return GOAL_OFF_RE.test(input.trim());
};

export type ParsedGoalVerify =
  | { kind: 'set'; command: string } // set the verify command
  | { kind: 'clear' }; // `/goal verify off` — clear it

/**
 * Parse a `/goal verify ...` control command. Returns null when the input is not
 * a verify control command. `/goal verify off|stop|clear` clears; otherwise the
 * remainder is the shell command run to independently verify a `done` claim.
 */
export const parseGoalVerifyCommand = (input: string): ParsedGoalVerify | null => {
  if (!input) return null;
  const match = input.trim().match(GOAL_VERIFY_RE);
  if (!match) return null;
  const rest = (match[1] ?? '').trim();
  if (rest === '' || /^(off|stop|clear)$/i.test(rest)) return { kind: 'clear' };
  return { kind: 'set', command: rest };
};

/**
 * Parse a raw composer input. Returns null when the text is not a goal command
 * or has no requirement after the command name.
 */
export const parseGoalCommand = (input: string): ParsedGoalCommand | null => {
  if (!input) return null;
  const trimmed = input.trim();
  // `/goal off` and `/goal verify ...` are control commands, not requirements.
  if (GOAL_OFF_RE.test(trimmed)) return null;
  if (GOAL_VERIFY_RE.test(trimmed)) return null;
  const match = trimmed.match(GOAL_COMMAND_RE);
  if (!match) return null;
  const variant = match[1].toLowerCase() === GOAL_ALL_COMMAND_NAME ? 'goal-all' : 'goal';
  const requirement = match[2].trim();
  if (!requirement) return null;
  return { variant, requirement };
};

// Shared mandatory pipeline. English headings keep it stable for the model while
// the directives are written so the agent acts immediately.
export const MANDATORY_PIPELINE = [
  'QUY TRÌNH BẮT BUỘC 100% (đi đủ, đúng thứ tự, lặp lại từ pha lỗi — KHÔNG bỏ/đảo bước):',
  '1. Phân tích query: bóc tách mục tiêu chính, ràng buộc, phạm vi, và tự suy ra "Definition of Done" nếu chưa nêu; ghi vào `.kiro/status.md`.',
  '2. Lấy data: dùng `mtui --json map intent` rồi `compass read`/`read` để gom file liên quan; cần thì dùng sub-agent context-gatherer một lần; web search khi thiếu thông tin ngoài codebase.',
  '3. Suy luận + bổ sung dữ liệu & năng lực còn thiếu: lấp khoảng trống kiến thức; rà `.claude/skills/SKILLS_GUIDE.md` và kích hoạt skill phù hợp (báo "Announce at start"); bổ sung thứ còn thiếu.',
  '4. Planning: chia thành các task rời rạc có thứ tự phụ thuộc rõ ràng, mỗi task có tiêu chí "xong" kiểm chứng được.',
  '5. Tối ưu plan cho sub-agent: nhóm task độc-lập-theo-file thành đợt chạy song song (≤ 3–4 general-task-execution sub-agent); file chung/integration/checkpoint chạy tuần tự (theo subagent-parallel).',
  '6. Thực hiện tasks: bám stack dự án (Arco + @icon-park/react + UnoCSS semantic token + i18n; renderer không Node API, main không DOM API); auto-fix `bun run lint:fix` + `bun run format`; chạm renderer/locale thì `bun run i18n:types` + `node scripts/check-i18n.js`.',
  '7. Quick test mỗi bước: sau MỖI task chạy quick test nhanh (script Python/Node một-lần, xóa file tạm sau khi xong) + `getDiagnostics` + `bunx tsc --noEmit` cho phần liên quan; PASS → đánh dấu task [x], FAIL → vào pha 9.',
  '8. Test lần cuối qua quick test tracker: sau MỖI tính năng/bước lớn/quan trọng, chạy cổng test chính thức `bun run test` (Vitest, kèm DOM test cho UI) + typecheck + lint + i18n; ghi kết quả từng mục vào `.kiro/status.md`.',
  '9. Khi lỗi (root-cause trước, theo systematic-debugging): tìm dữ liệu lỗi → suy luận root cause → planning fix → thực hiện fix → test lại → thành công thì trả kết quả, thất bại thì quay lại bước trước trong vòng này và thử cách khác.',
].join('\n');

export const RECOVERY_AND_RULES = [
  'Phục hồi khi treo (terminal treo / lỗi server / hang): đóng/kill tiến trình kẹt (KHÔNG kill app người dùng đang dùng), chờ ~5 phút cho tài nguyên giải phóng, rồi tự tiếp tục đúng pha đang dở (đọc `.kiro/status.md`), không làm lại từ đầu; treo lặp 2 lần cùng bước thì đánh dấu [-] và đi tiếp.',
  'Tự chủ (autonomous-run): KHÔNG hỏi lại người dùng — mọi quyết định tự quyết theo phương án hợp lý nhất và ghi 1 dòng lý do vào `.kiro/status.md`. Một lỗi tự sửa tối đa 2 lần; không xong thì đánh dấu task [-], ghi "Lỗi cần người dùng xử lý", rồi tiếp task kế tiếp — KHÔNG dừng cả phiên.',
  'An toàn: KHÔNG commit/push trừ khi yêu cầu nêu rõ; KHÔNG xóa dữ liệu hàng loạt; KHÔNG đụng production; KHÔNG dùng Claude/computer-use để test UI. Chỉ dừng hẳn khi gặp quyết định kiến trúc lớn không thể tự quyết an toàn (vd buộc sửa Rust backend aioncore).',
  'Cập nhật trạng thái task ([ ] → [x] hoặc [-]) ngay khi xong mỗi sub-task; trả lời người dùng bằng tiếng Việt, giữ tiếng Anh cho code/định danh/commit/key i18n.',
  GOAL_STATUS_CONTRACT,
].join('\n');

// Each variant only differs by a leading objective line, an intro paragraph, and
// a "done" line; the pipeline and the recovery/safety rules are identical. We
// precompute the static head/tail of each prompt once at module load so that
// expanding a command at send-time is a single string concatenation rather than
// re-joining several long arrays on every call.
type GoalVariantSpec = {
  /** Static text before the user requirement. */
  head: string;
  /** Static text after the user requirement (intro + pipeline + done + rules). */
  tail: string;
};

const buildTail = (intro: string, doneLine: string): string =>
  '\n\n' + [intro, '', MANDATORY_PIPELINE, '', doneLine, '', RECOVERY_AND_RULES].join('\n');

const GOAL_VARIANT_SPECS: Record<GoalCommandVariant, GoalVariantSpec> = {
  goal: {
    head: 'MỤC TIÊU (GOAL) của phiên này: ',
    tail: buildTail(
      'Hãy TỰ THỰC HIỆN theo vòng lặp khép kín (làm → kiểm tra → sửa → phát triển tiếp), lặp đến khi kết quả TIỆM CẬN HOÀN TOÀN (≈100%) so với mục tiêu trên, hoặc hết credit. Bắt đầu ngay, không hỏi lại.',
      'Điều kiện dừng: mọi tiêu chí Definition of Done PASS + test tracker xanh + typecheck/lint/i18n sạch; hoặc hết credit; hoặc gặp quyết định kiến trúc lớn không thể tự quyết an toàn.'
    ),
  },
  'goal-all': {
    head: 'MỤC TIÊU (GOAL-ALL — chế độ toàn quyền, khó tính hơn) của phiên này: ',
    tail: buildTail(
      'Bạn được TOÀN QUYỀN tự quyết mọi thứ để đạt 101% so với yêu cầu trên: kết quả tối thiểu phải NGANG mục tiêu, ưu tiên VƯỢT mục tiêu (chủ động bổ sung edge case, độ bền, test, tài liệu, trải nghiệm — miễn không phá vỡ ràng buộc dự án). Tự đặt tiêu chuẩn nghiệm thu nghiêm ngặt hơn mức tối thiểu. Bắt đầu ngay, tuyệt đối không hỏi lại; chạy đến khi xong hoặc hết credit.',
      'Tiêu chí "xong" của GOAL-ALL: vượt Definition of Done tự đặt (≥101%), test tracker xanh, typecheck/lint/i18n sạch, đã chủ động phủ các trường hợp biên/độ bền hợp lý. Chỉ dừng khi đạt mức này, hết credit, hoặc gặp quyết định kiến trúc lớn không thể tự quyết an toàn.'
    ),
  },
};

/**
 * Expand a `/goal` or `/goal-all` composer input into the full autonomous
 * instruction to send to the agent. Returns null when the input is not a goal
 * command (caller should then send the original text unchanged).
 */
export const expandGoalCommand = (input: string): string | null => {
  const parsed = parseGoalCommand(input);
  if (!parsed) return null;
  const spec = GOAL_VARIANT_SPECS[parsed.variant];
  return spec.head + parsed.requirement + spec.tail;
};
