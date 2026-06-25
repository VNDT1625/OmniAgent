/**
 * Headless scheduler — turns a Project into a flat, time-ordered list of audio
 * events (in seconds). This is the shared "brain" for BOTH realtime playback
 * (renderer Tone.js adapter consumes it) and offline export (render adapter
 * consumes the same list). Pure math over the schema, fully testable.
 *
 * Beats are converted to seconds using the project tempo. Step-sequencer steps
 * are interpreted as 16th notes (4 steps per beat) by default.
 */

import type { Project, Track } from '../shared/schema';

export type ScheduledEvent = {
  trackId: string;
  /** Absolute start time in seconds from song start. */
  timeSec: number;
  /** Event kind for the audio adapter to interpret. */
  kind: 'sample' | 'note';
  /** Sampler/audio events reference a sample. */
  sampleId?: string | null;
  /** Note events carry a MIDI pitch. */
  pitch?: number;
  /** Duration in seconds (notes/audio); 0 for one-shot samples. */
  durationSec: number;
  /** Linear gain 0..1 derived from velocity / track volume. */
  gain: number;
};

const STEPS_PER_BEAT = 4; // 16th-note grid

export function beatsToSeconds(beats: number, bpm: number): number {
  return (beats * 60) / bpm;
}

function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

function velocityToGain(velocity: number): number {
  return Math.max(0, Math.min(1, velocity / 127));
}

/** True if any track is soloed (then only soloed tracks play). */
function hasSolo(project: Project): boolean {
  return project.tracks.some((t) => t.solo);
}

function trackAudible(track: Track, soloActive: boolean): boolean {
  if (track.mute) return false;
  if (soloActive && !track.solo) return false;
  return true;
}

/**
 * Build a time-ordered event list for the whole project.
 * @param project the song.
 */
export function scheduleProject(project: Project): ScheduledEvent[] {
  const bpm = project.tempo;
  const soloActive = hasSolo(project);
  const events: ScheduledEvent[] = [];

  for (const track of project.tracks) {
    if (!trackAudible(track, soloActive)) continue;
    const trackGain = dbToGain(track.volumeDb);

    for (const clip of track.clips) {
      const clipStartSec = beatsToSeconds(clip.startBeat, bpm);

      if (clip.kind === 'pattern' && clip.steps) {
        for (const step of clip.steps) {
          const stepBeat = step.step / STEPS_PER_BEAT;
          events.push({
            trackId: track.id,
            timeSec: clipStartSec + beatsToSeconds(stepBeat, bpm),
            kind: 'sample',
            sampleId: step.sampleId ?? track.instrument?.sampleId ?? null,
            durationSec: 0,
            gain: trackGain * velocityToGain(step.velocity),
          });
        }
      } else if (clip.kind === 'midi' && clip.notes) {
        for (const note of clip.notes) {
          events.push({
            trackId: track.id,
            timeSec: clipStartSec + beatsToSeconds(note.startBeat, bpm),
            kind: 'note',
            pitch: note.pitch,
            durationSec: beatsToSeconds(note.lengthBeat, bpm),
            gain: trackGain * velocityToGain(note.velocity),
          });
        }
      } else if (clip.kind === 'audio' && clip.audio) {
        events.push({
          trackId: track.id,
          timeSec: clipStartSec,
          kind: 'sample',
          sampleId: clip.audio.sampleId,
          durationSec: beatsToSeconds(clip.lengthBeat, bpm),
          gain: trackGain * dbToGain(clip.audio.gainDb),
        });
      }
    }
  }

  events.sort((a, b) => a.timeSec - b.timeSec);
  return events;
}

/** Total song length in seconds (end of the last event). */
export function songDurationSec(project: Project): number {
  const events = scheduleProject(project);
  let end = 0;
  for (const e of events) {
    end = Math.max(end, e.timeSec + e.durationSec);
  }
  return end;
}
