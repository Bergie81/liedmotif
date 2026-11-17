'use client';

// Microphone capture for the My-voice setup: getUserMedia → MediaRecorder →
// decoded/measured mono WAV (`processCapturedAudio`). Browser cleanup
// (noise suppression / echo cancellation / auto gain) is a caller-controlled
// toggle — it can distort a voice, so the conservative default is OFF and the
// user compares takes by ear.

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from '@/lib/toast';
import { processCapturedAudio, type EncodedVoiceRecording } from '@/lib/voice-recording';

export type VoiceRecorderState = 'idle' | 'requesting' | 'recording' | 'processing';

export interface UseVoiceRecorderResult {
  state: VoiceRecorderState;
  /** Seconds since recording started (1s resolution, for the live counter). */
  elapsedSeconds: number;
  start: (options: { cleanup: boolean }) => Promise<void>;
  /** Stop and resolve the processed take; null when nothing was captured. */
  stop: () => Promise<EncodedVoiceRecording | null>;
}

/** A failed take is one toast, so the next attempt to record clears it. */
const FAILURE_KEY = 'voice-recorder';

const MIC_DENIED_MESSAGE =
  'Microphone access was blocked — allow it in the browser settings and try again.';

export function useVoiceRecorder(): UseVoiceRecorderResult {
  const [state, setState] = useState<VoiceRecorderState>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const tickerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // The permission prompt can outlive the panel; a stream granted after unmount
  // must be released, or the tab keeps a live microphone nothing can stop.
  const unmountedRef = useRef(false);

  const teardown = useCallback(() => {
    if (tickerRef.current) clearInterval(tickerRef.current);
    tickerRef.current = null;
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    chunksRef.current = [];
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    return () => {
      unmountedRef.current = true;
      teardown();
    };
  }, [teardown]);

  const start = useCallback(
    async ({ cleanup }: { cleanup: boolean }) => {
      if (state !== 'idle') return;
      toast.dismiss(FAILURE_KEY);
      setState('requesting');
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: cleanup,
            echoCancellation: cleanup,
            autoGainControl: cleanup,
          },
        });
        streamRef.current = stream;
        if (unmountedRef.current) {
          teardown();
          return;
        }
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorder.start();
        recorderRef.current = recorder;
        setElapsedSeconds(0);
        tickerRef.current = setInterval(() => setElapsedSeconds((s) => s + 1), 1000);
        setState('recording');
      } catch {
        teardown();
        toast.error(MIC_DENIED_MESSAGE, { key: FAILURE_KEY });
        setState('idle');
      }
    },
    [state, teardown],
  );

  const stop = useCallback(async (): Promise<EncodedVoiceRecording | null> => {
    const recorder = recorderRef.current;
    if (!recorder || state !== 'recording') return null;
    setState('processing');
    const captured = await new Promise<Blob>((resolve) => {
      const collect = () =>
        resolve(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
      // The browser stops a recorder itself when the microphone goes away or capture
      // fails; its data has arrived by then, and `stop()` would fire no event.
      if (recorder.state === 'inactive') return collect();
      recorder.onstop = collect;
      recorder.stop();
    });
    teardown();
    try {
      return await processCapturedAudio(captured);
    } catch {
      toast.error('Could not process the recording — try again.', { key: FAILURE_KEY });
      return null;
    } finally {
      setState('idle');
    }
  }, [state, teardown]);

  return { state, elapsedSeconds, start, stop };
}
