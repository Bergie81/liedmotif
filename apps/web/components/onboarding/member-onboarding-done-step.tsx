// The Member welcome's close: the budget they arrive with, who pays for it,
// and where to find the numbers later. Every figure comes from the same model
// enforcement uses, so nobody is welcomed with a number the next
// submit would contradict.

'use client';

import { useState } from 'react';
import { Check, Image, Music, Play, Users, Wallet, type LucideIcon } from 'lucide-react';
import type { MyBudgetPageData } from '@/lib/budget/my-budget-data';
import { OnboardingConfetti } from './onboarding-confetti';
import {
  OnboardingActions,
  OnboardingCard,
  OnboardingError,
  OnboardingPrimaryAction,
  OnboardingSubhead,
} from './onboarding-layout';

interface BudgetRow {
  icon: LucideIcon;
  title: string;
  description: string;
}

/** The Member's own budget, worded by its kind: a renewing allowance or one total. */
function ownBudgetRows(yours: MyBudgetPageData['yours'], payerName: string | null): BudgetRow[] {
  if (yours.kind === 'oneTime') {
    return [
      {
        icon: Music,
        title: `${yours.tracks.limit} tracks in total`,
        description: `New music made for you. This budget does not renew. When it runs out, sessions replay what they already made, and ${payerName ?? 'your host'} can give you more.`,
      },
      {
        icon: Image,
        title: `${yours.covers.limit} covers in total`,
        description: 'Generated art for your sessions. Uploading your own pictures does not count.',
      },
    ];
  }
  const { figures } = yours;
  return [
    {
      icon: Music,
      title: `${figures.tracksDay.limit} tracks a day, ${figures.tracksMonth.limit} a month`,
      description:
        'New music made for you. When you run out, sessions replay what they already made until your budget resets.',
    },
    {
      icon: Image,
      title: `${figures.coversDay.limit} covers a day, ${figures.coversMonth.limit} a month`,
      description: 'Generated art for your sessions. Uploading your own pictures does not count.',
    },
  ];
}

function budgetRows(budget: MyBudgetPageData): BudgetRow[] {
  return [
    ...ownBudgetRows(budget.yours, budget.payerName),
    {
      icon: Users,
      title: `A shared budget of ${budget.shared.tracksDay.limit} tracks a day`,
      description:
        'Everyone invited here shares it, so it can run out before your own budget does.',
    },
    {
      icon: Wallet,
      title: `${budget.payerName || 'Your host'} pays for your music`,
      description: 'New tracks and covers go on their account. Budgets keep that in check.',
    },
  ];
}

export function MemberOnboardingDoneStep({ budget }: { budget: MyBudgetPageData }) {
  const [finishing, setFinishing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    if (finishing) return;
    setError(null);
    setFinishing(true);
    const response = await fetch('/api/onboarding/complete', { method: 'POST' }).catch(() => null);
    if (response?.ok) {
      // A full navigation, not a client transition: the app guards are
      // server-side, so the shell re-renders against the onboarded state.
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
          You&apos;re on the Air!
        </h1>
      </header>
      <p className="mt-2 text-[14.5px] leading-relaxed text-muted">
        Describe what the music is for. Liedmotif makes it and keeps playing until you stop. Your
        music stays private unless you share it.
      </p>

      <OnboardingSubhead>Your Budget</OnboardingSubhead>
      <OnboardingCard className="mt-0">
        {budgetRows(budget).map(({ icon: Icon, title, description }) => (
          <div
            key={title}
            className="flex items-start gap-3 border-b border-line py-3 last:border-b-0"
          >
            <Icon className="mt-[2px] h-[17px] w-[17px] flex-none text-dim" aria-hidden />
            <div className="min-w-0 flex-1">
              <b className="block text-[13.5px] font-semibold">{title}</b>
              <span className="mt-[2px] block text-[12.5px] text-dim">{description}</span>
            </div>
          </div>
        ))}
      </OnboardingCard>
      <p className="mt-3.5 text-[13px] leading-relaxed text-dim">
        See what you have left any time in{' '}
        <b className="font-semibold text-paper">Settings › My Budget</b>.
      </p>

      <OnboardingError error={error} />

      <OnboardingActions>
        <OnboardingPrimaryAction
          label="Start Your First Session"
          busyLabel="Opening Liedmotif…"
          busy={finishing}
          icon={<Play className="h-[17px] w-[17px]" aria-hidden />}
          onClick={() => void finish()}
        />
      </OnboardingActions>
    </section>
  );
}
