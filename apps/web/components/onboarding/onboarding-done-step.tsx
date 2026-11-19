// Step 7 — the celebration, and the last word on what was decided without asking.
// Every row is worded from a real current value, so the list can never promise a
// default the instance is not on.

'use client';

import { useState } from 'react';
import {
  Check,
  Gauge,
  HardDrive,
  Image,
  Mail,
  Mic,
  Play,
  Waves,
  type LucideIcon,
} from 'lucide-react';
import { COVER_STYLE_LABELS } from '@/lib/covers/cover-styles';
import type { OnboardingUntouched } from '@/lib/onboarding/onboarding-data';
import { sessionLanguageLabel } from '@/lib/sessions/session-languages';
import { OnboardingConfetti } from './onboarding-confetti';
import {
  EnvVar,
  OnboardingActions,
  OnboardingCard,
  OnboardingError,
  OnboardingPrimaryAction,
  OnboardingSubhead,
} from './onboarding-layout';

interface UntouchedRow {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Which Settings page owns it, or `.env`, so the owner knows where to go later. */
  where: string;
}

function ownVoiceRow(ready: boolean): UntouchedRow {
  return {
    icon: Mic,
    title: ready ? 'Your singing voice is ready' : 'Your singing voice not set up',
    description: ready
      ? 'Sessions can sing in your voice when you ask them to'
      : 'Record a sample and Sessions can sing in your voice',
    where: 'My voice',
  };
}

function untouchedRows({
  playback,
  generation,
  coverStyle,
  ownVoiceOffer,
  accountEmail,
  storageProvider,
}: OnboardingUntouched): UntouchedRow[] {
  return [
    {
      icon: Mic,
      title: 'Instrumental by default',
      description:
        generation.defaultLanguage === 'auto'
          ? 'Turn on vocals for any Session, in the language you type'
          : `Turn on vocals for any Session, in ${sessionLanguageLabel(generation.defaultLanguage)}`,
      where: 'Generation',
    },
    {
      icon: Waves,
      title: playback.blendEnabled
        ? `Blending on, ${playback.crossfadeSeconds} second crossfade`
        : 'Blending off',
      where: 'Playback',
    },
    {
      icon: Gauge,
      title: generation.bufferEnabled
        ? `New Sessions generate ${generation.bufferAheadTracks} Tracks ahead`
        : 'New Sessions play existing Tracks',
      description: generation.bufferEnabled
        ? 'Keeps new music ready while you listen'
        : 'One first batch, then they loop. Change it for any Session in the player',
      where: 'Generation',
    },
    {
      icon: Image,
      title: `Cover style set to ${COVER_STYLE_LABELS[coverStyle]}`,
      description:
        coverStyle === 'auto'
          ? 'Each Session picks a look from its own mood'
          : 'Every Session uses this look until you change it',
      where: 'Cover art',
    },
    {
      icon: HardDrive,
      title:
        storageProvider === 's3' ? 'Tracks stored in an S3 bucket' : 'Tracks stored on local disk',
      where: 'Storage',
    },
    ...(ownVoiceOffer === 'hidden' ? [] : [ownVoiceRow(ownVoiceOffer === 'ready')]),
    {
      icon: Mail,
      title: accountEmail ? 'Account email on' : 'Account email off',
      description: accountEmail
        ? 'Invites and password resets go out by email'
        : 'Invites and password resets are links you copy. Set SMTP_URL and MAIL_FROM to email them',
      where: '.env',
    },
  ];
}

export function OnboardingDoneStep({ untouched }: { untouched: OnboardingUntouched }) {
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    if (finishing) return;
    setError(null);
    setFinishing(true);
    const response = await fetch('/api/onboarding/complete', { method: 'POST' }).catch(() => null);
    if (response?.ok) {
      // A full navigation, not a client transition: the app guards are server-side,
      // so the app shell has to be re-rendered against the now-onboarded state.
      window.location.assign('/');
      return;
    }
    setFinishing(false);
    setError('Could not finish setting up. Try again.');
  }

  return (
    <section>
      <OnboardingConfetti />
      <header className="flex items-center gap-4">
        <span
          aria-hidden
          className="grid h-[42px] w-[42px] flex-none place-items-center rounded-full [background:var(--gradient-primary)] text-[var(--on-lamp)] shadow-[var(--shadow-primary)] desk:h-14 desk:w-14"
        >
          <Check className="h-[22px] w-[22px] desk:h-[30px] desk:w-[30px]" strokeWidth={2.6} />
        </span>
        <h1 className="font-display text-[clamp(26px,7vw,34px)] font-extrabold leading-[1.12] tracking-[-0.025em]">
          You&apos;re on the air!
        </h1>
      </header>
      <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
        Describe what the music is for. Liedmotif makes it and keeps playing until you stop.
      </p>

      <OnboardingSubhead>Left at the defaults</OnboardingSubhead>
      <p className="mb-3.5 text-[14.5px] leading-relaxed text-muted">
        Change them any time in Settings, or in <EnvVar>.env</EnvVar> where marked.
      </p>

      <OnboardingCard className="mt-0">
        {untouchedRows(untouched).map(({ icon: Icon, title, description, where }) => (
          <div
            key={title}
            className="flex items-start gap-3 border-b border-line py-3 last:border-b-0"
          >
            <Icon className="mt-[2px] h-[17px] w-[17px] flex-none text-dim" aria-hidden />
            <div className="min-w-0 flex-1">
              <b className="block text-[13.5px] font-semibold">{title}</b>
              {description ? (
                <span className="mt-[2px] block text-[12.5px] text-dim">{description}</span>
              ) : null}
            </div>
            <span className="self-center whitespace-nowrap font-mono text-[9.5px] uppercase tracking-[0.08em] text-dim">
              {where}
            </span>
          </div>
        ))}
      </OnboardingCard>

      <OnboardingError error={error} />

      <OnboardingActions>
        <OnboardingPrimaryAction
          label="Start your first Session"
          busyLabel="Opening Liedmotif…"
          busy={finishing}
          icon={<Play className="h-[17px] w-[17px]" aria-hidden />}
          onClick={() => void finish()}
        />
      </OnboardingActions>
    </section>
  );
}
