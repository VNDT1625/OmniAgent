import { describe, expect, it } from 'vitest';
import {
  appProviderModels,
  tomnyModelArgs,
} from '../../../packages/desktop/src/process/experimentalCore/adapters/tomnyCoreAdapter';

describe('Tomny app provider catalog', () => {
  it('uses enabled models from app settings and does not expose secrets as CLI arguments', () => {
    const models = appProviderModels([
      {
        id: 'provider:one',
        platform: 'openai',
        name: 'App API',
        base_url: 'https://example.test/v1',
        api_key: 'secret',
        models: ['gpt-5.6', 'disabled'],
        model_enabled: { disabled: false },
        enabled: true,
      },
    ]);
    expect(models).toEqual([
      expect.objectContaining({
        modelId: 'gpt-5.6',
        label: 'gpt-5.6 (App API)',
        providerId: 'provider:one',
        isDefault: true,
      }),
    ]);
    expect(tomnyModelArgs(models[0]?.key)).toEqual([]);
  });
});
