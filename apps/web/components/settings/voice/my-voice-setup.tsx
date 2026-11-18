'use client';

// Settings -> My voice: the whole profile workflow as one client surface.
// The server holds the real state machine; this component renders the current
// `VoiceProfileView`, records/uploads takes, triggers workflow submits, and
// polls the GET (refresh-on-read) while a provider task is in flight.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, Square, Trash2 } from 'lucide-react';
import {
  VOICE_LANGUAGES,
  VOICE_SOURCE_MAX_SECONDS,
  VOICE_SOURCE_MIN_SECONDS,
  VOICE_VERIFICATION_MAX_SECONDS,
  VOICE_VERIFICATION_MIN_SECONDS,
  type VoiceLanguage,
  type VoiceProfileView,
  type VoiceRecordingKindValue,
} from '@liedmotif/shared';
import { requestVoiceProfile } from '@/lib/api-client';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { FAILURE_BACKOFF_JITTER, FAILURE_BACKOFF_MAX_MS, pollBackoffMs } from '@/lib/poll-backoff';
import type { EncodedVoiceRecording } from '@/lib/voice-recording';
import { Switch } from '@/components/ui/controls';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SettingsCard,
  SettingsControlRow,
  SettingsFeedback,
  SettingsFootnote,
} from '@/components/settings/settings-ui';
import { useVoiceRecorder } from './use-voice-recorder';

const LANGUAGE_LABELS: Record<VoiceLanguage, string> = {
  en: 'English',
  zh: 'Chinese',
  es: 'Spanish',
  fr: 'French',
  pt: 'Portuguese',
  de: 'German',
  ja: 'Japanese',
  ko: 'Korean',
  hi: 'Hindi',
  ru: 'Russian',
};

/** Every step's failure shares one toast, so the next step's success clears it. */
const FAILURE_KEY = 'voice-setup';

/** Poll cadence while a provider task is in flight (server throttles further). */
const IN_FLIGHT_POLL_MS = 4_000;

/** The canonical validated client, narrowed to this surface's result shape. */
type VoiceApiInit = Parameters<typeof requestVoiceProfile>[1];
async function voiceApi(
  path: string,
  init?: VoiceApiInit,
): Promise<{ profile?: VoiceProfileView; error?: string }> {
  const result = await requestVoiceProfile(path, init);
  return result.ok ? { profile: result.data.profile } : { error: result.error.message };
}

export function MyVoiceSetup({ initial }: { initial: VoiceProfileView }) {
  const [view, setView] = useState<VoiceProfileView>(initial);
  const [busy, setBusy] = useState(false);

  const applyResult = useCallback((result: { profile?: VoiceProfileView; error?: string }) => {
    if (result.profile) {
      setView(result.profile);
      toast.dismiss(FAILURE_KEY);
    } else {
      toast.error(result.error ?? 'Something went wrong.', { key: FAILURE_KEY });
    }
    return result.profile !== undefined;
  }, []);

  const mutate = useCallback(
    async (path: string, init?: VoiceApiInit) => {
      setBusy(true);
      toast.dismiss(FAILURE_KEY);
      const succeeded = applyResult(await voiceApi(path, init));
      setBusy(false);
      return succeeded;
    },
    [applyResult],
  );

  // While a provider task runs, keep reading — the GET is the poller.
  // Completion-scheduled (the next tick arms only after the response settles,
  // so a slow server never stacks overlapping reads), aborted on cleanup, and
  // idle while the tab is hidden — profile creation runs for minutes.
  const inFlight = view.status === 'validating_source' || view.status === 'creating_voice';
  useEffect(() => {
    if (!inFlight) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    // Back off only on a failed read; the normal cadence is unchanged while the
    // endpoint answers, so a flaky server isn't hammered at full 4s.
    let failures = 0;
    function schedule() {
      timer = setTimeout(
        () => void tick(),
        pollBackoffMs({
          failures,
          baseMs: IN_FLIGHT_POLL_MS,
          maxMs: FAILURE_BACKOFF_MAX_MS,
          jitterRatio: FAILURE_BACKOFF_JITTER,
        }),
      );
    }
    async function tick() {
      if (controller.signal.aborted) return;
      if (document.visibilityState === 'hidden') {
        schedule();
        return;
      }
      const result = await voiceApi('/api/settings/voice', { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (result.profile) {
        failures = 0;
        setView(result.profile);
      } else {
        failures += 1;
      }
      schedule();
    }
    schedule();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [inFlight]);

  if (!view.setupSupported) {
    return (
      <SettingsCard>
        <p className="py-3 text-[13.5px] text-muted">
          The configured music provider does not support custom voice profiles.
        </p>
      </SettingsCard>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {!view.generationSupported ? (
        <SettingsFeedback kind="info">
          The configured music model cannot sing with a custom voice yet — switch to a music model
          that supports it (Settings → AI Providers) to use it in Sessions. You can still set the
          profile up.
        </SettingsFeedback>
      ) : null}

      {view.status === 'none' ? (
        <ConsentCard
          busy={busy}
          onCreate={(language) =>
            mutate('/api/settings/voice', {
              method: 'POST',
              body: { consent: true, ...(language ? { language } : {}) },
            })
          }
        />
      ) : null}

      {view.status === 'draft' || view.status === 'failed' ? (
        <SettingsCard>
          {view.status === 'failed' ? (
            <div className="pt-3">
              <SettingsFeedback kind="error">
                {view.errorMessageSafe ?? 'Voice setup failed — try again with a new recording.'}
              </SettingsFeedback>
            </div>
          ) : null}
          <RecorderPanel
            kind="source"
            title="Source sample"
            description={`Sing or rap for ${VOICE_SOURCE_MIN_SECONDS}–${VOICE_SOURCE_MAX_SECONDS} seconds in a quiet room. Dry vocals only — no backing music.`}
            minSeconds={VOICE_SOURCE_MIN_SECONDS}
            maxSeconds={VOICE_SOURCE_MAX_SECONDS}
            hasStored={view.hasSourceRecording}
            busy={busy}
            mutate={mutate}
          />
          <div className="border-t border-line py-4">
            <button
              type="button"
              disabled={busy || !view.hasSourceRecording}
              onClick={() => void mutate('/api/settings/voice/validate', { method: 'POST' })}
              className={cn(primaryButtonClass, 'w-full')}
            >
              Submit for validation
            </button>
            <SettingsFootnote>
              The selected recording is sent to the music provider to validate your voice. The
              provider then issues a short phrase to record next.
            </SettingsFootnote>
          </div>
          {view.verificationPhrase ? (
            <VerificationSection view={view} busy={busy} mutate={mutate} />
          ) : null}
        </SettingsCard>
      ) : null}

      {inFlight ? (
        <SettingsCard>
          <p className="flex items-center gap-3 py-4 text-[13.5px] text-muted">
            <span className="h-2 w-2 animate-pulse rounded-full bg-lamp" aria-hidden />
            {view.status === 'validating_source'
              ? 'The music provider is validating your source sample…'
              : 'The music provider is creating your voice…'}
          </p>
        </SettingsCard>
      ) : null}

      {view.status === 'awaiting_verification' ? (
        <SettingsCard>
          <VerificationSection view={view} busy={busy} mutate={mutate} />
        </SettingsCard>
      ) : null}

      {view.status === 'ready' || view.status === 'disabled' ? (
        <SettingsCard>
          <SettingsControlRow
            label={view.status === 'ready' ? 'My voice is ready' : 'My voice is disabled'}
            description={
              view.status === 'ready'
                ? 'Vocal Sessions can sing with your voice — turn on “Own Voice” when starting one.'
                : 'The profile is kept but not offered when starting Sessions.'
            }
          >
            <Switch
              checked={view.status === 'ready'}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void mutate('/api/settings/voice', { method: 'PATCH', body: { enabled } })
              }
              aria-label="Offer my voice for new Sessions"
            />
          </SettingsControlRow>
          {view.hasSourceRecording ? (
            <div className="border-b border-line py-3 last:border-b-0">
              <p className="mb-2 text-[13px] font-semibold text-paper">Source sample</p>
              <StoredRecordingPreview kind="source" />
            </div>
          ) : null}
          {view.hasVerificationRecording ? (
            <div className="py-3">
              <p className="mb-2 text-[13px] font-semibold text-paper">Verification recording</p>
              <StoredRecordingPreview kind="verification" />
            </div>
          ) : null}
        </SettingsCard>
      ) : null}

      {view.status !== 'none' ? (
        <SettingsCard>
          <SettingsControlRow
            label="Delete voice profile"
            description="Removes the profile and deletes the stored recordings."
          >
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                if (!window.confirm('Delete your voice profile and its recordings?')) return;
                void mutate('/api/settings/voice', { method: 'DELETE' });
              }}
              className={cn(secondaryButtonClass, 'inline-flex items-center gap-2 text-warn')}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Delete
            </button>
          </SettingsControlRow>
        </SettingsCard>
      ) : null}
    </div>
  );
}

function ConsentCard({
  busy,
  onCreate,
}: {
  busy: boolean;
  onCreate: (language: VoiceLanguage | '') => void;
}) {
  const [consented, setConsented] = useState(false);
  const [language, setLanguage] = useState<VoiceLanguage | ''>('');
  return (
    <SettingsCard>
      <div className="py-4">
        <p className="text-[13.5px] leading-[1.6] text-muted">
          Record your own singing voice and let vocal Sessions sing with it. Before you start:
        </p>
        <ul className="mt-3 list-disc space-y-1.5 pl-5 text-[13px] leading-[1.5] text-muted">
          <li>Liedmotif stores your recordings on this server.</li>
          <li>
            The configured music provider receives the recording you submit to create a voice
            profile.
          </li>
          <li>The voice profile may be used to generate singing or rapping in new music.</li>
          <li>You can disable or delete the voice profile at any time.</li>
          <li>This feature is for your own voice only — never someone else’s.</li>
        </ul>
        <label className="mt-4 flex flex-col gap-2 text-[13px] font-semibold text-paper">
          Singing language
          <Select
            value={language || 'provider'}
            onValueChange={(value) =>
              setLanguage(value === 'provider' ? '' : (value as VoiceLanguage))
            }
          >
            <SelectTrigger aria-label="Singing language" className="w-full font-normal">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="w-[var(--radix-select-trigger-width)]">
              <SelectItem value="provider">Let the provider decide</SelectItem>
              {VOICE_LANGUAGES.map((code) => (
                <SelectItem key={code} value={code}>
                  {LANGUAGE_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="mt-4 flex items-start gap-3 text-[13px] leading-[1.5] text-muted">
          <input
            type="checkbox"
            checked={consented}
            onChange={(event) => setConsented(event.target.checked)}
            className="mt-0.5 h-4 w-4"
          />
          I am recording my own voice and agree to the points above.
        </label>
        <button
          type="button"
          disabled={busy || !consented}
          onClick={() => onCreate(language)}
          className={cn(primaryButtonClass, 'mt-4 w-full')}
        >
          Set up my voice
        </button>
      </div>
    </SettingsCard>
  );
}

function VerificationSection({
  view,
  busy,
  mutate,
}: {
  view: VoiceProfileView;
  busy: boolean;
  mutate: (path: string, init?: VoiceApiInit) => Promise<boolean>;
}) {
  return (
    <>
      <div className="border-t border-line py-4">
        <p className="text-[13px] font-semibold text-paper">Verification phrase</p>
        <p className="mt-1 text-[12.5px] text-dim">
          Record exactly this phrase — singing it works best:
        </p>
        <blockquote className="mt-3 rounded-card-sm border border-lamp/35 bg-lamp/[0.06] px-4 py-3 text-[15px] font-medium leading-[1.5] text-lamp">
          “{view.verificationPhrase}”
        </blockquote>
      </div>
      <RecorderPanel
        kind="verification"
        title="Verification recording"
        description={`Record the phrase above (${VOICE_VERIFICATION_MIN_SECONDS}–${VOICE_VERIFICATION_MAX_SECONDS} seconds).`}
        minSeconds={VOICE_VERIFICATION_MIN_SECONDS}
        maxSeconds={VOICE_VERIFICATION_MAX_SECONDS}
        hasStored={view.hasVerificationRecording}
        busy={busy}
        mutate={mutate}
      />
      <div className="border-t border-line py-4">
        <button
          type="button"
          disabled={busy || !view.hasVerificationRecording}
          onClick={() => void mutate('/api/settings/voice/verify', { method: 'POST' })}
          className={cn(primaryButtonClass, 'w-full')}
        >
          Create my voice
        </button>
        <SettingsFootnote>
          The verification recording is sent to the music provider; your voice profile is ready a
          short while later.
        </SettingsFootnote>
      </div>
    </>
  );
}

/** One take lifecycle: record → review (metrics + preview) → save (upload). */
function RecorderPanel({
  kind,
  title,
  description,
  minSeconds,
  maxSeconds,
  hasStored,
  busy,
  mutate,
}: {
  kind: VoiceRecordingKindValue;
  title: string;
  description: string;
  minSeconds: number;
  maxSeconds: number;
  hasStored: boolean;
  busy: boolean;
  /** The parent's mutation, so the upload holds `busy` and no workflow step (Submit,
   *  Create) can read the stored take while it is being replaced. */
  mutate: (path: string, init?: VoiceApiInit) => Promise<boolean>;
}) {
  const recorder = useVoiceRecorder();
  const [cleanup, setCleanup] = useState(false);
  const [take, setTake] = useState<(EncodedVoiceRecording & { url: string }) | null>(null);
  const [uploading, setUploading] = useState(false);
  const takeUrlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
    },
    [],
  );

  function setNewTake(encoded: EncodedVoiceRecording | null) {
    if (takeUrlRef.current) URL.revokeObjectURL(takeUrlRef.current);
    takeUrlRef.current = null;
    if (!encoded) {
      setTake(null);
      return;
    }
    const url = URL.createObjectURL(encoded.wav);
    takeUrlRef.current = url;
    setTake({ ...encoded, url });
  }

  const tooShort = take !== null && take.metrics.durationSeconds < minSeconds;
  const tooLong = take !== null && take.metrics.durationSeconds > maxSeconds;
  const clipping = take !== null && take.metrics.clippedRatio > 0.001;
  const tooQuiet = take !== null && take.metrics.loudnessDbfs < -40;
  const blocked = tooShort || tooLong;

  async function saveTake() {
    if (!take) return;
    setUploading(true);
    const form = new FormData();
    form.set('file', new File([take.wav], `${kind}.wav`, { type: 'audio/wav' }));
    form.set('kind', kind);
    form.set('durationSeconds', String(take.metrics.durationSeconds));
    form.set('peakDbfs', String(Math.min(0, take.metrics.peakDbfs)));
    form.set('loudnessLufs', String(Math.min(0, take.metrics.loudnessDbfs)));
    const saved = await mutate('/api/settings/voice/recordings', { method: 'POST', form });
    setUploading(false);
    if (saved) setNewTake(null);
  }

  return (
    <div className="py-4">
      <p className="text-[13px] font-semibold text-paper">{title}</p>
      <p className="mt-1 text-[12.5px] leading-[1.5] text-dim">{description}</p>

      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[12.5px] text-muted">
          Browser mic cleanup
          <span className="block text-[11px] text-dim">
            Noise suppression can color your voice — compare takes by ear.
          </span>
        </span>
        <Switch
          checked={cleanup}
          disabled={recorder.state !== 'idle'}
          onCheckedChange={setCleanup}
          aria-label="Browser mic cleanup"
        />
      </div>

      <div className="mt-4 flex items-center gap-3">
        {recorder.state === 'recording' ? (
          <button
            type="button"
            onClick={() => void recorder.stop().then((encoded) => encoded && setNewTake(encoded))}
            className={cn(primaryButtonClass, 'inline-flex items-center gap-2')}
          >
            <Square className="h-4 w-4" aria-hidden />
            Stop ({recorder.elapsedSeconds}s)
          </button>
        ) : (
          <button
            type="button"
            disabled={recorder.state !== 'idle' || busy || uploading}
            onClick={() => void recorder.start({ cleanup })}
            className={cn(secondaryButtonClass, 'inline-flex items-center gap-2')}
          >
            <Mic className="h-4 w-4" aria-hidden />
            {take || hasStored ? 'Record again' : 'Start recording'}
          </button>
        )}
        {recorder.state === 'processing' ? (
          <span className="text-[12.5px] text-dim">Processing…</span>
        ) : null}
      </div>

      {take ? (
        <div className="mt-4 rounded-card-sm border border-line-2 bg-paper/[0.02] p-3">
          <audio controls src={take.url} className="w-full" />
          <p className="mt-2 font-mono text-[11px] tracking-[0.04em] text-dim">
            {take.metrics.durationSeconds.toFixed(1)}S · PEAK {take.metrics.peakDbfs.toFixed(1)}{' '}
            dBFS
          </p>
          {tooShort ? (
            <p className="mt-1 text-[12.5px] text-warn">
              Too short — record at least {minSeconds} seconds.
            </p>
          ) : null}
          {tooLong ? (
            <p className="mt-1 text-[12.5px] text-warn">
              Too long — keep it under {maxSeconds} seconds.
            </p>
          ) : null}
          {clipping ? (
            <p className="mt-1 text-[12.5px] text-warn">
              The recording clips — lower your input level or step back from the mic.
            </p>
          ) : null}
          {tooQuiet ? (
            <p className="mt-1 text-[12.5px] text-warn">
              Very quiet — move closer to the mic or raise the input level.
            </p>
          ) : null}
          <button
            type="button"
            disabled={blocked || uploading || busy}
            onClick={() => void saveTake()}
            className={cn(primaryButtonClass, 'mt-3 w-full')}
          >
            {uploading ? 'Saving…' : hasStored ? 'Replace saved recording' : 'Save recording'}
          </button>
        </div>
      ) : null}

      {hasStored && !take ? (
        <div className="mt-4">
          <p className="mb-2 text-[12.5px] text-dim">Saved recording</p>
          <StoredRecordingPreview kind={kind} />
        </div>
      ) : null}
    </div>
  );
}

function StoredRecordingPreview({ kind }: { kind: VoiceRecordingKindValue }) {
  // Played from a blob URL because the route answers without byte ranges, which
  // Safari requires of a direct media `src`. Fetched on mount, which is exactly
  // when the stored take may have changed.
  const [src, setSrc] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    void fetch(`/api/settings/voice/recordings/${kind}`, { cache: 'no-store' })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (cancelled || !blob) return;
        url = URL.createObjectURL(blob);
        setSrc(url);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [kind]);
  return <audio controls preload="metadata" src={src} className="w-full" />;
}
