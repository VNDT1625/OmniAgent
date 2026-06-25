/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { foreignLanguageRatio } from '@/renderer/services/i18n/languageDetect';

describe('foreignLanguageRatio', () => {
  it('returns 0 for unknown language code', () => {
    expect(foreignLanguageRatio('hello world this is a sentence', 'xx-YY')).toBe(0);
  });

  it('returns 0 for too-short input (no reliable verdict)', () => {
    expect(foreignLanguageRatio('hi', 'vi-VN')).toBe(0);
    expect(foreignLanguageRatio('你好', 'zh-CN')).toBe(0);
  });

  it('ignores fenced code, inline code and URLs when judging prose', () => {
    const viWithCode =
      'Đây là đoạn mã bạn cần dùng để khởi tạo dịch vụ một cách an toàn nhé:\n\n```ts\nconst service = createService({ retries: 3 });\nservice.start();\n```\n\nXem thêm tại https://example.com/docs nha.';
    // Despite a sizeable English code block, the prose is Vietnamese → low foreign ratio.
    expect(foreignLanguageRatio(viWithCode, 'vi-VN')).toBeLessThan(0.3);
  });

  describe('Vietnamese system language', () => {
    const vi =
      'Chào bạn, tôi đã hoàn thành việc cập nhật cấu hình và kiểm tra lại toàn bộ luồng dữ liệu của ứng dụng rồi nhé.';
    const en =
      'Hello, I have finished updating the configuration and re-checked the entire data flow of the application for you.';

    it('treats a fully Vietnamese reply as native (low ratio)', () => {
      expect(foreignLanguageRatio(vi, 'vi-VN')).toBeLessThan(0.3);
    });

    it('flags a fully English reply as foreign (high ratio)', () => {
      expect(foreignLanguageRatio(en, 'vi-VN')).toBeGreaterThan(0.5);
    });

    it('does not over-escalate Vietnamese mixed with some English terms', () => {
      const mixed =
        'Mình đã thêm middleware xử lý authentication và viết unit test cho service đó, bạn chạy lại pipeline để kiểm tra nhé.';
      expect(foreignLanguageRatio(mixed, 'vi-VN')).toBeLessThan(0.45);
    });
  });

  describe('Chinese system language', () => {
    it('treats Chinese reply as native', () => {
      expect(foreignLanguageRatio('我已经完成了配置更新并重新检查了整个数据流程。', 'zh-CN')).toBeLessThan(0.2);
    });

    it('flags an English reply as foreign', () => {
      expect(
        foreignLanguageRatio('I have finished updating the configuration and rechecked the whole data flow.', 'zh-CN')
      ).toBeGreaterThan(0.8);
    });
  });

  describe('English system language', () => {
    it('treats an English reply as native', () => {
      expect(
        foreignLanguageRatio('I have finished updating the configuration and rechecked the whole data flow.', 'en-US')
      ).toBeLessThan(0.1);
    });

    it('flags a Chinese reply as foreign', () => {
      expect(foreignLanguageRatio('我已经完成了配置更新并重新检查了整个数据流程内容。', 'en-US')).toBeGreaterThan(0.8);
    });
  });

  describe('Russian system language', () => {
    it('treats a Russian reply as native', () => {
      expect(foreignLanguageRatio('Я закончил обновление конфигурации и перепроверил весь поток данных.', 'ru-RU')).toBeLessThan(0.2);
    });

    it('flags an English reply as foreign', () => {
      expect(foreignLanguageRatio('I have finished updating the configuration completely.', 'ru-RU')).toBeGreaterThan(0.8);
    });
  });
});
