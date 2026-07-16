/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Condition evaluation for the Automation control-flow nodes (`control.if`,
 * `control.switch`, `control.filter`).
 *
 * A condition compares a left-hand value (a `{{input}}`-templated string, or a
 * dotted path into the pipeline input object) against a right-hand value with a
 * small, safe operator set — no arbitrary code is evaluated. Keeping this in one
 * pure module lets the engine and the tests share identical semantics.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** The comparison operators a condition may use. */
export type ConditionOperator =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'notContains'
  | 'startsWith'
  | 'endsWith'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'isEmpty'
  | 'isNotEmpty'
  | 'isTrue'
  | 'isFalse'
  | 'regex';

/** A single condition: `left <op> right`. */
export type Condition = {
  /** Left operand. A `{{input}}`-templated string or a dotted path (see {@link resolveValue}). */
  left: string;
  /** The operator. */
  operator: ConditionOperator;
  /** Right operand (templated). Unused for unary operators (`isEmpty`…). */
  right?: string;
};

/** Read a dotted path (`a.b.0.c`) out of an object/array; `undefined` when absent. */
const readPath = (root: unknown, path: string): unknown => {
  const parts = path.split('.').filter((p) => p.length > 0);
  let cur: unknown = root;
  for (const part of parts) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) {
      const idx = Number(part);
      cur = Number.isInteger(idx) ? cur[idx] : undefined;
    } else if (typeof cur === 'object') {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return cur;
};

/** Stringify the pipeline input for `{{input}}` substitution. */
const inputToString = (input: unknown): string =>
  typeof input === 'string' ? input : input == null ? '' : JSON.stringify(input);

/**
 * Resolve an operand string against the pipeline input. Rules:
 *  - `{{input}}` (and `{{input.a.b}}`) interpolate from the input.
 *  - A bare `$.a.b` or `input.a.b` reads that path from the input object.
 *  - Anything else is treated as a literal string.
 */
export const resolveValue = (operand: string, input: unknown): string => {
  const raw = operand ?? '';
  if (/\{\{\s*input(\.[^}]+)?\s*\}\}/.test(raw)) {
    return raw.replace(/\{\{\s*input(\.[^}]*)?\s*\}\}/g, (_m, path: string | undefined) => {
      if (!path) return inputToString(input);
      const value = readPath(input, path.replace(/^\./, ''));
      return inputToString(value);
    });
  }
  const pathMatch = raw.match(/^(?:\$\.|input\.)(.+)$/);
  if (pathMatch) return inputToString(readPath(input, pathMatch[1]));
  return raw;
};

/** Coerce a string to a finite number, or NaN. */
const toNumber = (value: string): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Evaluate one {@link Condition} against the pipeline input. Returns a boolean;
 * never throws (a bad regex degrades to `false`).
 */
export const evaluateCondition = (condition: Condition, input: unknown): boolean => {
  const left = resolveValue(condition.left ?? '', input);
  const right = resolveValue(condition.right ?? '', input);

  switch (condition.operator) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'contains':
      return left.includes(right);
    case 'notContains':
      return !left.includes(right);
    case 'startsWith':
      return left.startsWith(right);
    case 'endsWith':
      return left.endsWith(right);
    case 'gt':
      return toNumber(left) > toNumber(right);
    case 'gte':
      return toNumber(left) >= toNumber(right);
    case 'lt':
      return toNumber(left) < toNumber(right);
    case 'lte':
      return toNumber(left) <= toNumber(right);
    case 'isEmpty':
      return left.length === 0;
    case 'isNotEmpty':
      return left.length > 0;
    case 'isTrue':
      return left === 'true' || left === '1';
    case 'isFalse':
      return left === 'false' || left === '0' || left.length === 0;
    case 'regex':
      try {
        return new RegExp(right).test(left);
      } catch {
        return false;
      }
    default:
      return false;
  }
};

/** Read a {@link Condition} out of an open node config (defensive). */
export const conditionFromConfig = (config: Record<string, unknown>): Condition => ({
  left: typeof config.left === 'string' ? config.left : '{{input}}',
  operator: (typeof config.operator === 'string' ? config.operator : 'isNotEmpty') as ConditionOperator,
  right: typeof config.right === 'string' ? config.right : undefined,
});
