/**
 * WAV (PCM 16-bit) encoding/decoding — pure, dependency-free.
 *
 * Used by the offline renderer to produce export files and to load sample data
 * for mixing in headless tests. No Node/DOM; operates on ArrayBuffer/typed
 * arrays so it runs anywhere (main process render path can reuse it too).
 */

export type AudioBuffer = {
  sampleRate: number;
  /** Mono channel data in [-1..1]. */
  samples: Float32Array;
};

/** Encode mono Float32 samples to a 16-bit PCM WAV byte buffer. */
export function encodeWav(buffer: AudioBuffer): Uint8Array {
  const { samples, sampleRate } = buffer;
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = samples.length * bytesPerSample;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);

  writeAscii(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(view, 8, 'WAVE');
  writeAscii(view, 12, 'fmt ');
  view.setUint32(16, 16, true); // PCM fmt chunk size
  view.setUint16(20, 1, true); // audio format = PCM
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 8 * bytesPerSample, true);
  writeAscii(view, 36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, Math.round(clamped * 0x7fff), true);
    offset += 2;
  }
  return new Uint8Array(out);
}

/** Decode a 16-bit PCM WAV byte buffer to mono Float32 samples. */
export function decodeWav(bytes: Uint8Array): AudioBuffer {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') {
    throw new Error('Not a RIFF/WAVE file');
  }

  let offset = 12;
  let sampleRate = 44100;
  let numChannels = 1;
  let bitsPerSample = 16;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= view.byteLength) {
    const id = readAscii(view, offset, 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (id === 'fmt ') {
      numChannels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bitsPerSample = view.getUint16(body + 14, true);
    } else if (id === 'data') {
      dataOffset = body;
      dataSize = size;
    }
    offset = body + size + (size % 2); // chunks are word-aligned
  }

  if (dataOffset < 0) throw new Error('No data chunk');
  if (bitsPerSample !== 16) throw new Error(`Unsupported bit depth: ${bitsPerSample}`);

  const frameCount = Math.floor(dataSize / (numChannels * 2));
  const samples = new Float32Array(frameCount);
  let p = dataOffset;
  for (let i = 0; i < frameCount; i++) {
    // Downmix to mono by averaging channels.
    let sum = 0;
    for (let c = 0; c < numChannels; c++) {
      sum += view.getInt16(p, true) / 0x7fff;
      p += 2;
    }
    samples[i] = sum / numChannels;
  }
  return { sampleRate, samples };
}

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

function readAscii(view: DataView, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}
