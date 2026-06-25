/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Realtime playback for the Music Studio — a thin Tone.js adapter over the
 * headless scheduler in @aionui/music-core. It reads `scheduleProject()` (the
 * SAME event list the offline renderer + the agent use) and plays it back live
 * through the Web Audio API.
 *
 * Process boundary: Renderer module (Web Audio). No Node.js APIs.
 *
 * Design: synthesized sounds (membrane synth for sample/drum events, a poly
 * synth for MIDI notes) so playback works with zero loaded samples — same
 * spirit as the offline `synthDrumBank`. Loaded samples can be wired later.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as Tone from 'tone';
import { decodeWav, midiToHz, scheduleProject, songDurationSec, type Project } from '@aionui/music-core';
import { musicClient } from './musicClient';

export type PlayerState = 'stopped' | 'playing';

export type UseMusicPlayer = {
  state: PlayerState;
  /** Start realtime playback of the given project. Resumes the AudioContext. */
  play: (project: Project, projectPath?: string) => Promise<void>;
  /** Stop playback and clear scheduled events. */
  stop: () => void;
};

function toUint8Array(bytes: Uint8Array | ArrayBuffer | number[]): Uint8Array {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  return new Uint8Array(bytes);
}

function sampleCacheKey(projectPath: string, sampleId: string): string {
  return `${projectPath}\u0000${sampleId}`;
}

export function useMusicPlayer(): UseMusicPlayer {
  const [state, setState] = useState<PlayerState>('stopped');
  const drumRef = useRef<Tone.MembraneSynth | null>(null);
  const polyRef = useRef<Tone.PolySynth | null>(null);
  const stopTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sampleBuffers = useRef<Map<string, globalThis.AudioBuffer>>(new Map());

  const teardown = useCallback(() => {
    Tone.getTransport().stop();
    Tone.getTransport().cancel();
    if (stopTimer.current) {
      clearTimeout(stopTimer.current);
      stopTimer.current = null;
    }
  }, []);

  const ensureInstruments = useCallback(() => {
    if (!drumRef.current) drumRef.current = new Tone.MembraneSynth().toDestination();
    if (!polyRef.current) polyRef.current = new Tone.PolySynth(Tone.Synth).toDestination();
  }, []);

  const stop = useCallback(() => {
    teardown();
    setState('stopped');
  }, [teardown]);

  const loadSampleBuffers = useCallback(async (project: Project, projectPath: string | undefined): Promise<void> => {
    if (!projectPath) return;

    const knownSamples = new Set(project.samples.map((sample) => sample.id));
    const sampleIds = new Set<string>();
    for (const event of scheduleProject(project)) {
      if (event.kind === 'sample' && event.sampleId && knownSamples.has(event.sampleId)) {
        sampleIds.add(event.sampleId);
      }
    }

    const audioContext = Tone.getContext().rawContext;
    await Promise.all(
      Array.from(sampleIds).map(async (sampleId) => {
        const cacheKey = sampleCacheKey(projectPath, sampleId);
        if (sampleBuffers.current.has(cacheKey)) return;
        const result = await musicClient.loadSample(projectPath, sampleId);
        if ('error' in result) throw new Error(result.error);
        const decoded = decodeWav(toUint8Array(result.data.bytes));
        const buffer = audioContext.createBuffer(1, decoded.samples.length, decoded.sampleRate);
        buffer.getChannelData(0).set(decoded.samples);
        sampleBuffers.current.set(cacheKey, buffer);
      })
    );
  }, []);

  const play = useCallback(
    async (project: Project, projectPath?: string) => {
      await Tone.start(); // resume AudioContext on user gesture
      ensureInstruments();
      teardown();

      const events = scheduleProject(project);
      const transport = Tone.getTransport();
      await loadSampleBuffers(project, projectPath);

      for (const ev of events) {
        if (ev.kind === 'note' && ev.pitch !== undefined) {
          const hz = midiToHz(ev.pitch);
          const dur = Math.max(0.05, ev.durationSec);
          transport.schedule((time) => {
            polyRef.current?.triggerAttackRelease(hz, dur, time, Math.max(0.1, ev.gain));
          }, ev.timeSec);
        } else if (ev.kind === 'sample') {
          const buffer =
            projectPath && ev.sampleId
              ? sampleBuffers.current.get(sampleCacheKey(projectPath, ev.sampleId))
              : undefined;
          if (buffer) {
            transport.schedule((time) => {
              const audioContext = Tone.getContext().rawContext;
              const source = audioContext.createBufferSource();
              const gain = audioContext.createGain();
              source.buffer = buffer;
              gain.gain.setValueAtTime(Math.max(0, ev.gain), time);
              source.connect(gain);
              gain.connect(audioContext.destination);
              source.start(time, 0, ev.durationSec > 0 ? ev.durationSec : undefined);
            }, ev.timeSec);
            continue;
          }

          // Fallback for demo projects and missing samples.
          transport.schedule((time) => {
            drumRef.current?.triggerAttackRelease('C2', 0.12, time, Math.max(0.1, ev.gain));
          }, ev.timeSec);
        }
      }

      const total = songDurationSec(project) + 0.5;
      transport.position = 0;
      transport.start();
      setState('playing');

      stopTimer.current = setTimeout(() => stop(), Math.max(500, total * 1000));
    },
    [ensureInstruments, loadSampleBuffers, stop, teardown]
  );

  useEffect(() => {
    return () => {
      teardown();
      drumRef.current?.dispose();
      polyRef.current?.dispose();
      drumRef.current = null;
      polyRef.current = null;
    };
  }, [teardown]);

  return { state, play, stop };
}
