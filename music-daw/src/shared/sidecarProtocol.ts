/**
 * Renderer <-> Rust sidecar protocol (JSON-RPC over stdio).
 *
 * Heavy/offline DSP runs in a Rust child process spawned by the main process.
 * The realtime audio path NEVER goes through here — only batch jobs that can
 * take time and report progress (export, pitch analysis, vocal tune, stem
 * separation).
 *
 * Message framing: one JSON object per line (newline-delimited JSON).
 *
 *   request:  { id, method, params }
 *   progress: { id, event: "progress", value }   (0..1, may repeat)
 *   success:  { id, result }
 *   error:    { id, error: { code, message } }
 *
 * These types are shared so the renderer client and any mock/test harness agree
 * on the wire format before the Rust crate exists.
 */

export type ExportFormat = 'wav' | 'mp3';

export type SidecarMethod = 'export.render' | 'analyze.pitch' | 'tune.process' | 'stem.separate';

export type SidecarParams = {
  'export.render': {
    projectPath: string;
    format: ExportFormat;
    bitrate?: number; // for mp3
    stems?: boolean;
  };
  'analyze.pitch': {
    projectPath: string;
    sampleId: string;
  };
  'tune.process': {
    projectPath: string;
    sampleId: string;
    keyRoot: number;
    scale: 'major' | 'minor' | 'chromatic';
    strengthPct: number;
  };
  'stem.separate': {
    projectPath: string;
    sampleId: string;
  };
};

export type PitchPoint = { tSec: number; hz: number; conf: number };

export type SidecarResults = {
  'export.render': { outputPath?: string; stemPaths?: string[] };
  'analyze.pitch': { pitchCurve: PitchPoint[] };
  'tune.process': { outputSampleId: string; outputPath: string };
  'stem.separate': { stemPaths: string[] };
};

export type SidecarRequest<M extends SidecarMethod = SidecarMethod> = {
  id: number;
  method: M;
  params: SidecarParams[M];
};

export type SidecarProgress = {
  id: number;
  event: 'progress';
  value: number; // 0..1
};

export type SidecarSuccess<M extends SidecarMethod = SidecarMethod> = {
  id: number;
  result: SidecarResults[M];
};

export type SidecarError = {
  id: number;
  error: { code: string; message: string };
};

export type SidecarResponse<M extends SidecarMethod = SidecarMethod> =
  | SidecarProgress
  | SidecarSuccess<M>
  | SidecarError;

export const isProgress = (msg: SidecarResponse): msg is SidecarProgress => 'event' in msg && msg.event === 'progress';

export const isError = (msg: SidecarResponse): msg is SidecarError => 'error' in msg;

export const isSuccess = <M extends SidecarMethod>(msg: SidecarResponse<M>): msg is SidecarSuccess<M> =>
  'result' in msg;

/** Encode a request as a newline-delimited JSON frame. */
export const encodeRequest = (req: SidecarRequest): string => `${JSON.stringify(req)}\n`;

/** Parse one line of sidecar output into a response object. */
export const parseResponseLine = (line: string): SidecarResponse | null => {
  const trimmed = line.trim();
  if (!trimmed) return null;
  return JSON.parse(trimmed) as SidecarResponse;
};
