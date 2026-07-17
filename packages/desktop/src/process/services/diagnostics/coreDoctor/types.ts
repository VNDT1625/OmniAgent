/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

export type CoreDoctorCheck = {
  id: string;
  status: 'pass' | 'warning' | 'error';
  summary: string;
  targetId?: string;
};

export type CoreDoctorReport = {
  generatedAt: number;
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: CoreDoctorCheck[];
  metrics: {
    runCount: number;
    startupP95Ms?: number;
    completionRate: number;
    retryRate: number;
    toolFailureRate: number;
    firstTokenP95Ms?: number;
    completionP95Ms?: number;
  };
};
