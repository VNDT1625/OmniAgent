/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for @aionui/music-core — the headless music engine shared by the
 * user UI and the agent (MCP) plane. Covers engine commands, the agent's audio
 * analysis ("ears"), offline render, and the agent tool catalog.
 */

import { describe, expect, it } from 'vitest';

import {
  addPatternClip,
  addTrack,
  analyzeAudio,
  chordFromMidi,
  createProject,
  detectKey,
  detectPitch,
  dispatchTool,
  hzToNoteName,
  isValidProject,
  renderProject,
  renderStems,
  scheduleProject,
  setStep,
  setTempo,
  sine,
  suggestProgression,
  computeChroma,
  type Project,
  type SampleBank,
} from '@aionui/music-core';

const SR = 44100;

describe('music-core: schema + engine', () => {
  it('creates a valid empty project', () => {
    const p = createProject('Demo');
    expect(isValidProject(p)).toBe(true);
  });

  it('builds a 2-step beat via engine commands', () => {
    let p = createProject('Beat');
    p = setTempo(p, 140);
    const t = addTrack(p, 'Drums');
    p = t.project;
    const c = addPatternClip(p, t.trackId, 0, 4);
    p = c.project;
    p = setStep(p, t.trackId, c.clipId, 0, 'kick', 120);
    p = setStep(p, t.trackId, c.clipId, 8, 'kick', 110);
    expect(p.tempo).toBe(140);
    expect(p.tracks[0].clips[0].steps).toHaveLength(2);
  });
});

describe('music-core: the agent ears', () => {
  it('hears A4 from a 440Hz sine', () => {
    const r = detectPitch(sine(440, 0.2, SR).subarray(0, 2048), SR);
    expect(r.hz).not.toBeNull();
    expect(Math.abs((r.hz as number) - 440)).toBeLessThan(1);
    expect(hzToNoteName(r.hz as number)).toBe('A4');
  });

  it('hears the key from a C major chord', () => {
    const chroma = computeChroma(chordFromMidi([60, 64, 67], 0.5, SR).subarray(0, 8192), SR);
    const key = detectKey(chroma);
    expect(key.tonic === 0 || key.tonic === 9).toBe(true);
  });

  it('analyzeAudio returns a full summary', () => {
    const a = analyzeAudio(sine(440, 1, SR), SR);
    expect(a.pitch.note).toBe('A4');
    expect(a.chroma).toHaveLength(12);
  });
});

describe('music-core: scheduler + render', () => {
  it('schedules steps at correct times', () => {
    let p = createProject('x');
    p = setTempo(p, 120);
    const t = addTrack(p, 'D');
    p = t.project;
    const c = addPatternClip(p, t.trackId, 0, 4);
    p = c.project;
    p = setStep(p, t.trackId, c.clipId, 4, 'k', 100);
    const events = scheduleProject(p);
    expect(events).toHaveLength(1);
    expect(events[0].timeSec).toBeCloseTo(0.5, 6);
  });

  it('renders a non-silent buffer and stems', () => {
    let p = createProject('Render');
    p = setTempo(p, 120);
    const t = addTrack(p, 'Drums');
    p = t.project;
    const c = addPatternClip(p, t.trackId, 0, 4);
    p = c.project;
    p = setStep(p, t.trackId, c.clipId, 0, 'kick', 120);
    const bank: SampleBank = new Map();
    bank.set('kick', { sampleRate: SR, samples: sine(80, 0.1, SR) });

    const mix = renderProject(p, bank, { sampleRate: SR });
    let peak = 0;
    for (let i = 0; i < mix.samples.length; i++) peak = Math.max(peak, Math.abs(mix.samples[i]));
    expect(peak).toBeGreaterThan(0.1);

    const stems = renderStems(p, bank, { sampleRate: SR });
    expect(stems).toHaveLength(1);
  });
});

describe('music-core: agent tool plane', () => {
  it('drives the DAW through tool calls', () => {
    let project: Project = createProject('AgentBeat');
    let r = dispatchTool('set_tempo', { bpm: 90 }, { project });
    expect(r.ok).toBe(true);
    project = r.project as Project;

    r = dispatchTool('add_track', { name: 'Drums' }, { project });
    project = r.project as Project;
    const trackId = r.data?.trackId as string;
    expect(trackId).toBeTruthy();

    r = dispatchTool('add_pattern_clip', { trackId }, { project });
    project = r.project as Project;
    const clipId = r.data?.clipId as string;

    r = dispatchTool('set_step', { trackId, clipId, step: 0, sampleId: 'kick', velocity: 120 }, { project });
    project = r.project as Project;
    expect(project.tracks[0].clips[0].steps).toHaveLength(1);
  });

  it('listen returns key + suggested progression', () => {
    const audio = { samples: chordFromMidi([60, 64, 67], 1, SR), sampleRate: SR };
    const r = dispatchTool('listen', {}, { project: createProject('x'), audio });
    expect(r.ok).toBe(true);
    expect(typeof r.data?.key).toBe('string');
  });

  it('suggestProgression yields 4 chords', () => {
    expect(suggestProgression(0, 'major')).toHaveLength(4);
  });
});
