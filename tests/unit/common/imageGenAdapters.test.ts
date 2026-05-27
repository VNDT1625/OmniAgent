/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImageAdapterParams } from '@/common/chat/imageGen/types';

// ── Top-level mocks (hoisted by vitest) ───────────────────────────────────────

const mockSaveGeneratedImage = vi.fn().mockResolvedValue('/workspace/img-123.png');
const mockFileToBase64 = vi.fn().mockResolvedValue('ZmFrZWltYWdl');
const mockGetImageMimeType = vi.fn().mockReturnValue('image/png');
const mockProcessImageUri = vi.fn();
const mockResolveLocalImageBuffer = vi.fn();

vi.mock('@/common/chat/imageGen/utils', () => ({
  saveGeneratedImage: mockSaveGeneratedImage,
  fileToBase64: mockFileToBase64,
  getImageMimeType: mockGetImageMimeType,
  processImageUri: mockProcessImageUri,
  resolveLocalImageBuffer: mockResolveLocalImageBuffer,
  isHttpUrl: (s: string) => s.startsWith('http://') || s.startsWith('https://'),
  getFileExtensionFromDataUrl: () => '.png',
}));

const mockCreateChatCompletion = vi.fn();
vi.mock('@/common/api/ClientFactory', () => ({
  ClientFactory: {
    createRotatingClient: vi.fn().mockResolvedValue({ createChatCompletion: mockCreateChatCompletion }),
  },
  normalizeNewApiBaseUrl: vi.fn((u: string) => u),
}));

const mockCreateImage = vi.fn();
const mockEditImage = vi.fn();
vi.mock('@/common/api/OpenAIRotatingClient', () => {
  class MockOpenAIRotatingClient {
    createImage = mockCreateImage;
    editImage = mockEditImage;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    constructor(_keys: string, _config: unknown, _opts: unknown) {}
  }
  return { OpenAIRotatingClient: MockOpenAIRotatingClient };
});

vi.mock('@/common/utils/platformConstants', () => ({ isNewApiPlatform: vi.fn().mockReturnValue(false) }));
vi.mock('@office-ai/aioncli-core', () => ({ AuthType: { USE_OPENAI: 'openai' } }));
vi.mock('openai', () => ({ toFile: vi.fn().mockResolvedValue({ name: 'test.png' }) }));

// ── OpenAIChatAdapter ──────────────────────────────────────────────────────────

describe('OpenAIChatAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveGeneratedImage.mockResolvedValue('/workspace/img-123.png');
    mockFileToBase64.mockResolvedValue('ZmFrZWltYWdl');
    mockGetImageMimeType.mockReturnValue('image/png');
  });

  it('generates an image from message.images', async () => {
    const { OpenAIChatAdapter } = await import('@/common/chat/imageGen/adapters/openai-chat');

    mockCreateChatCompletion.mockResolvedValue({
      choices: [
        {
          message: {
            content: 'Here is your image.',
            images: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,abc123' } }],
          },
        },
      ],
    });

    const params: ImageAdapterParams = {
      prompt: 'a cat',
      imageUris: [],
      provider: {
        id: '1',
        name: 'Gemini',
        platform: 'gemini',
        base_url: '',
        api_key: 'key',
        use_model: 'gemini-flash-image',
      },
      workspaceDir: '/workspace',
    };

    const result = await OpenAIChatAdapter.generate(params);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('image_url');
  });

  it('throws when no images are returned', async () => {
    const { OpenAIChatAdapter } = await import('@/common/chat/imageGen/adapters/openai-chat');

    mockCreateChatCompletion.mockResolvedValue({
      choices: [{ message: { content: 'No image here.', images: [] } }],
    });

    const params: ImageAdapterParams = {
      prompt: 'a dog',
      imageUris: [],
      provider: {
        id: '1',
        name: 'Gemini',
        platform: 'gemini',
        base_url: '',
        api_key: 'key',
        use_model: 'gemini-flash-image',
      },
      workspaceDir: '/workspace',
    };

    await expect(OpenAIChatAdapter.generate(params)).rejects.toThrow('did not produce any images');
  });

  it('throws when API returns no choices', async () => {
    const { OpenAIChatAdapter } = await import('@/common/chat/imageGen/adapters/openai-chat');
    mockCreateChatCompletion.mockResolvedValue({ choices: [] });

    const params: ImageAdapterParams = {
      prompt: 'x',
      imageUris: [],
      provider: {
        id: '1',
        name: 'Gemini',
        platform: 'gemini',
        base_url: '',
        api_key: 'key',
        use_model: 'gemini-flash-image',
      },
      workspaceDir: '/workspace',
    };

    await expect(OpenAIChatAdapter.generate(params)).rejects.toThrow('No response');
  });
});

// ── OpenAIImagesAdapter ────────────────────────────────────────────────────────

const imageProvider: ImageAdapterParams['provider'] = {
  id: '1',
  name: 'OpenAI',
  platform: 'custom',
  base_url: 'https://api.openai.com/v1',
  api_key: 'key',
  use_model: 'gpt-image-2',
};

describe('OpenAIImagesAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSaveGeneratedImage.mockResolvedValue('/workspace/img-123.png');
    mockFileToBase64.mockResolvedValue('ZmFrZWltYWdl');
    mockGetImageMimeType.mockReturnValue('image/png');
  });

  it('generates an image via /v1/images/generations without response_format for gpt-image-2', async () => {
    const { OpenAIImagesAdapter } = await import('@/common/chat/imageGen/adapters/openai-images');

    mockCreateImage.mockResolvedValue({ data: [{ b64_json: 'abc123base64' }] });

    const params: ImageAdapterParams = {
      prompt: 'a sunset',
      imageUris: [],
      provider: imageProvider,
      workspaceDir: '/workspace',
    };

    const result = await OpenAIImagesAdapter.generate(params);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('image_url');
    // gpt-image-2 always returns b64 natively — response_format must NOT be sent
    expect(mockCreateImage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'gpt-image-2', size: '1024x1024' }),
      expect.anything()
    );
    expect(mockCreateImage).toHaveBeenCalledWith(
      expect.not.objectContaining({ response_format: expect.anything() }),
      expect.anything()
    );
  });

  it('sends response_format: b64_json for dall-e-3', async () => {
    const { OpenAIImagesAdapter } = await import('@/common/chat/imageGen/adapters/openai-images');

    mockCreateImage.mockResolvedValue({ data: [{ b64_json: 'abc123base64' }] });

    const params: ImageAdapterParams = {
      prompt: 'a sunset',
      imageUris: [],
      provider: { ...imageProvider, use_model: 'dall-e-3' },
      workspaceDir: '/workspace',
    };

    await OpenAIImagesAdapter.generate(params);
    expect(mockCreateImage).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'dall-e-3', response_format: 'b64_json' }),
      expect.anything()
    );
  });

  it('throws when /v1/images/generations returns empty data', async () => {
    const { OpenAIImagesAdapter } = await import('@/common/chat/imageGen/adapters/openai-images');
    mockCreateImage.mockResolvedValue({ data: [] });

    const params: ImageAdapterParams = {
      prompt: 'nothing',
      imageUris: [],
      provider: imageProvider,
      workspaceDir: '/workspace',
    };

    await expect(OpenAIImagesAdapter.generate(params)).rejects.toThrow('/v1/images/generations');
  });

  it('edits an image via /v1/images/edits', async () => {
    const { OpenAIImagesAdapter } = await import('@/common/chat/imageGen/adapters/openai-images');

    mockResolveLocalImageBuffer.mockResolvedValue({
      buffer: Buffer.from('fakepng'),
      mimeType: 'image/png',
      filename: 'test.png',
    });
    mockEditImage.mockResolvedValue({ data: [{ b64_json: 'editedbase64' }] });

    const params: ImageAdapterParams = {
      prompt: 'add a hat',
      imageUris: ['test.png'],
      provider: imageProvider,
      workspaceDir: '/workspace',
    };

    const result = await OpenAIImagesAdapter.edit!(params);
    expect(result).toHaveLength(1);
    expect(mockEditImage).toHaveBeenCalled();
  });

  it('throws edit() when no image_uris provided', async () => {
    const { OpenAIImagesAdapter } = await import('@/common/chat/imageGen/adapters/openai-images');

    const params: ImageAdapterParams = {
      prompt: 'add a hat',
      imageUris: [],
      provider: imageProvider,
      workspaceDir: '/workspace',
    };

    await expect(OpenAIImagesAdapter.edit!(params)).rejects.toThrow('at least one image_uri');
  });
});
