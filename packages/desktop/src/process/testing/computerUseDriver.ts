/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `computerUseDriver` — the FALLBACK automation driver (Yêu cầu 2b, criterion
 * 2.8b): screenshot → vision model decides → click/type at coordinates. Used
 * when a script cannot do the job. Like the script driver, every action targets
 * the ISOLATED virtual display (criterion 2.8 / Property 1) — it NEVER drives the
 * real OS cursor.
 *
 * The vision model and the (tab/display-scoped) input sink are injected, so this
 * module only orchestrates the see→decide→act loop and stays unit-testable.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { DriverContext, DriverStepResult, ITestDriver } from './scriptDriver';
import type { TestStep } from './testingTypes';

/** A decided UI action the vision model returns for a step. */
export type VisionAction =
  | { type: 'click'; x: number; y: number }
  | { type: 'type'; text: string }
  | { type: 'done'; passed: boolean; detail?: string };

/** Vision model that, given a screenshot + step, decides the next action. */
export type VisionModel = {
  /**
   * Decide the next action for `step` given the current `screenshot` (data URL or
   * path) of the isolated display.
   */
  decide(step: TestStep, screenshot: string): Promise<VisionAction>;
};

/** Captures the isolated display as a screenshot (path or data URL). */
export type DisplayCapture = {
  capture(target: Record<string, string>): Promise<string>;
};

/**
 * Input sink scoped to the isolated display (NOT OS-global). Mirrors the browser
 * `InputSink` idea: all input is confined to the test session's display.
 */
export type DisplayInputSink = {
  click(target: Record<string, string>, x: number, y: number): Promise<void>;
  type(target: Record<string, string>, text: string): Promise<void>;
};

/** Options for {@link createComputerUseDriver}. */
export type ComputerUseDriverDeps = {
  /** Vision model that decides actions. */
  vision: VisionModel;
  /** Screenshot capture for the isolated display. */
  capture: DisplayCapture;
  /** Display-scoped input sink (never OS-global). */
  input: DisplayInputSink;
  /** Max see→decide→act iterations per step before giving up. Defaults to 8. */
  maxActionsPerStep?: number;
};

/**
 * Create the computer-use fallback {@link ITestDriver}.
 *
 * @param deps Vision model, capture, display-scoped input + limits.
 * @returns A driver that drives the isolated display via screenshots + vision.
 */
export const createComputerUseDriver = (deps: ComputerUseDriverDeps): ITestDriver => {
  const maxActions = deps.maxActionsPerStep ?? 8;

  const runStep = async (step: TestStep, context: DriverContext): Promise<DriverStepResult> => {
    for (let i = 0; i < maxActions; i++) {
      const screenshot = await deps.capture.capture(context.target);
      const action = await deps.vision.decide(step, screenshot);
      switch (action.type) {
        case 'click':
          // Input is confined to the isolated display target (Property 1).
          await deps.input.click(context.target, action.x, action.y);
          break;
        case 'type':
          await deps.input.type(context.target, action.text);
          break;
        case 'done':
          return { passed: action.passed, detail: action.detail };
      }
    }
    return { passed: false, detail: `Step did not complete within ${maxActions} vision actions` };
  };

  return { kind: 'computer-use', runStep };
};
