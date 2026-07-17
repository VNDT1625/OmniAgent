import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { describe, expect, it } from 'vitest';
import {
  evaluateAcpCompatibility,
  supportedAcpFeatures,
  validateAcpCatalog,
} from '@process/experimentalCore/adapters/acpCompatibility';
import { CORE_ADAPTER_DEFINITIONS } from '@process/experimentalCore/coreRegistry';

describe('ACP compatibility contract', () => {
  it('keeps every built-in ACP target launch contract valid', () => {
    const acpTargets = CORE_ADAPTER_DEFINITIONS.filter((definition) => definition.protocol === 'acp');
    expect(acpTargets.length).toBeGreaterThan(0);
    expect(validateAcpCatalog(acpTargets)).toEqual([]);
  });

  it('degrades optional image and model selection when an agent does not advertise them', () => {
    const report = evaluateAcpCompatibility(
      { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
      { required: ['text'], preferred: ['image', 'model-selection'] }
    );
    expect(report.status).toBe('degraded');
    expect(report.degradedFeatures).toEqual(['image', 'model-selection']);
  });

  it('rejects an unsupported protocol version before using provider capabilities', () => {
    const report = evaluateAcpCompatibility({ protocolVersion: -1, agentCapabilities: {} });
    expect(report.status).toBe('incompatible');
    expect(report.reasons[0]).toContain('protocol version');
  });

  it('normalizes advertised prompt, session, MCP and model features', () => {
    const supported = supportedAcpFeatures({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: true, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, resume: {}, fork: {}, close: {} },
      },
      models: { currentModelId: 'model-a', availableModels: [{ modelId: 'model-a', name: 'Model A' }] },
    });
    expect(supported).toEqual(
      expect.arrayContaining([
        'image',
        'audio',
        'embedded-context',
        'load-session',
        'session-list',
        'session-resume',
        'session-fork',
        'session-close',
        'mcp-http',
        'mcp-sse',
        'model-selection',
      ])
    );
  });

  it('marks missing required image input as incompatible', () => {
    const report = evaluateAcpCompatibility(
      { protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} },
      { required: ['text', 'image'] }
    );
    expect(report.status).toBe('incompatible');
    expect(report.missingRequired).toEqual(['image']);
  });

  it('detects duplicated and malformed ACP catalog entries', () => {
    const invalid = {
      id: 'dup',
      name: '',
      protocol: 'acp' as const,
      candidates: [],
      args: [],
      detail: '',
      runnable: true,
    };
    const issues = validateAcpCatalog([invalid, { ...invalid, name: 'Duplicate', candidates: ['agent'] }]);
    expect(issues.some((issue) => issue.message.includes('duplicated'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('candidates'))).toBe(true);
  });
});
