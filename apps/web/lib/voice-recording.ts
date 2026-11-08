// Client-side voice-capture helpers: decode a MediaRecorder capture, measure
// simple quality metrics, and re-encode to mono 16-bit WAV. WAV makes the
// upload codec-independent (Chrome records webm/opus, Safari mp4/aac) and is
// what the provider workflow receives, so what you preview is what you submit.

export interface VoiceRecordingMetrics {
  durationSeconds: number;
  /** Peak sample level in dBFS (0 = full scale); -Infinity for silence. */
  peakDbfs: number;
  /** RMS loudness in dBFS — a rough LUFS stand-in for advisory checks. */
  loudnessDbfs: number;
  /** Share of samples within 0.25 dB of full scale — a clipping indicator. */
  clippedRatio: number;
}

export interface EncodedVoiceRecording {
  wav: Blob;
  metrics: VoiceRecordingMetrics;
}

/** Mix an AudioBuffer down to one mono Float32 channel. */
function mixToMono(buffer: AudioBuffer): Float32Array {
  const mono = new Float32Array(buffer.length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i += 1) mono[i]! += data[i]! / buffer.numberOfChannels;
  }
  return mono;
}

function measure(samples: Float32Array, sampleRate: number): VoiceRecordingMetrics {
  let peak = 0;
  let sumSquares = 0;
  let clipped = 0;
  const clipThreshold = 10 ** (-0.25 / 20); // within 0.25 dB of full scale
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    if (magnitude >= clipThreshold) clipped += 1;
    sumSquares += sample * sample;
  }
  const rms = Math.sqrt(sumSquares / Math.max(1, samples.length));
  return {
    durationSeconds: samples.length / sampleRate,
    peakDbfs: 20 * Math.log10(peak || Number.EPSILON),
    loudnessDbfs: 20 * Math.log10(rms || Number.EPSILON),
    clippedRatio: clipped / Math.max(1, samples.length),
  };
}

/** Encode mono float samples as a 16-bit PCM WAV blob. */
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
  const dataBytes = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]!));
    view.setInt16(44 + i * 2, Math.round(clamped * 0x7fff), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Decode a captured blob (whatever the browser recorded), measure it, and
 * re-encode as mono WAV. Uses a short-lived OfflineAudioContext-free path:
 * `decodeAudioData` handles any playable capture format.
 */
export async function processCapturedAudio(captured: Blob): Promise<EncodedVoiceRecording> {
  const arrayBuffer = await captured.arrayBuffer();
  const AudioContextCtor =
    window.AudioContext ??
    (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) throw new Error('Web Audio is not available in this browser.');
  const context = new AudioContextCtor();
  try {
    const decoded = await context.decodeAudioData(arrayBuffer);
    const mono = mixToMono(decoded);
    return {
      wav: encodeWav(mono, decoded.sampleRate),
      metrics: measure(mono, decoded.sampleRate),
    };
  } finally {
    await context.close().catch(() => undefined);
  }
}
