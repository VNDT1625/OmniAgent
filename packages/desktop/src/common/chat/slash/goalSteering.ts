/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { GOAL_STATUS_CONTRACT, MANDATORY_PIPELINE, RECOVERY_AND_RULES, type GoalCommandVariant } from './goalCommand';

/**
 * Persistent "Goal Mode" steering.
 *
 * A one-shot `/goal` message can fall out of the model's context after a few
 * turns. Goal Mode keeps the workflow binding by re-injecting steering on EVERY
 * turn (deterministically, at the renderer layer — not relying on the backend),
 * until the user turns it off with `/goal off`.
 *
 * `GOAL_TURN_REMINDER` is the compact reminder prepended to each ordinary turn
 * while Goal Mode is active. `buildGoalSteering` is the full steering block (used
 * for the initial activation / anywhere the complete pipeline is wanted).
 *
 * Note: this guarantees the steering TEXT is present every turn; it cannot force
 * an LLM to comply 100% (no text mechanism can). True structural enforcement
 * would require gating the agent's tool loop in the backend.
 */

/** Compact, firm reminder injected on every ordinary turn while Goal Mode is on. */
export const GOAL_TURN_REMINDER = [
  '[GOAL MODE — STEERING BẮT BUỘC] Phiên đang ở chế độ Goal. MỌI phản hồi PHẢI tuân thủ QUY TRÌNH BẮT BUỘC, không bỏ/đảo bước:',
  'phân tích query → lấy data → suy luận + bổ sung skill còn thiếu → planning → tối ưu plan cho sub-agent → thực hiện → quick test sau MỖI task → quick test tracker sau mỗi bước lớn → lỗi thì root-cause → fix → test lại (lặp).',
  'Tự chủ: KHÔNG hỏi lại, tự quyết hợp lý + ghi `.kiro/status.md`; một lỗi tự sửa ≤2 lần rồi đánh dấu [-] và đi tiếp. KHÔNG commit/push/xóa hàng loạt/đụng production trừ khi được yêu cầu. Chạy đến khi đạt mục tiêu (≈100%) hoặc hết credit. Gõ `/goal off` để tắt chế độ này.',
  GOAL_STATUS_CONTRACT,
].join('\n');

/** Full Goal Mode steering block (pipeline + recovery/safety rules). */
export const buildGoalSteering = (variant: GoalCommandVariant): string => {
  const header = variant === 'goal-all' ? '[GOAL-ALL MODE — STEERING BẮT BUỘC] Toàn quyền tự quyết, nhắm 101% (tối thiểu ngang mục tiêu, ưu tiên vượt). MỌI turn phải theo:' : '[GOAL MODE — STEERING BẮT BUỘC] MỌI turn phải theo:';
  return [header, '', MANDATORY_PIPELINE, '', RECOVERY_AND_RULES].join('\n');
};
