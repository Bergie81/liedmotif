// Step 4 — the Admin's own Track ceiling. The Admin pays the music provider
// directly, so the day and month caps are opt-in; "Generating at once" is a spend
// throttle that binds either way. Every figure is in Tracks (what the owner
// hears); the route converts to whole provider calls, which is why each steps by a
// multiple of the provider's per-call Track yield.

'use client';

import { Gauge, Zap } from 'lucide-react';
import { SettingsControlRow } from '@/components/settings/settings-ui';
import { Switch } from '@/components/ui/controls';
import { cn } from '@/lib/cn';
import { normalizeTracksPerRequest } from '@/lib/budget/track-units';
import {
  OnboardingCard,
  OnboardingLimitRow,
  OnboardingNote,
  OnboardingSpendActions,
  OnboardingStepHeader,
  OnboardingSubhead,
} from './onboarding-layout';
import {
  bindingTrackCap,
  maxConcurrentTracks,
  stepLimit,
  switchTrackCeiling,
  trackCapFloor,
  trackCeilingPatch,
  type TrackCeiling,
} from './onboarding-limits-model';
import { trackCeilingNote } from './onboarding-model';
import { useLimitSave } from './use-limit-save';

type TrackField = Exclude<keyof TrackCeiling, 'enabled'>;

export function OnboardingTracksStep({
  ceiling,
  tracksPerRequest,
  minHeadroomTracks,
  onChange,
  onDone,
}: {
  ceiling: TrackCeiling;
  tracksPerRequest: number;
  /** The stored Session-start headroom; a cap below it would block every new Session. */
  minHeadroomTracks: number;
  onChange: (ceiling: TrackCeiling) => void;
  onDone: () => void;
}) {
  const { saving, error, save } = useLimitSave(onDone);
  const trackYield = normalizeTracksPerRequest(tracksPerRequest);
  const concurrentMax = maxConcurrentTracks(tracksPerRequest);
  const capFloor = trackCapFloor(minHeadroomTracks, tracksPerRequest);
  const binding = bindingTrackCap(ceiling);
  const note = trackCeilingNote(binding.tracks);
  const capsDisabled = saving || !ceiling.enabled;

  function step(field: TrackField, amount: number, bounds: { min: number; max?: number }) {
    onChange({ ...ceiling, [field]: stepLimit(ceiling[field], amount, bounds) });
  }

  return (
    <section>
      <OnboardingStepHeader eyebrow="Optional" title="Set a Track Limit">
        Every new track costs money. A limit stops new tracks for the day or month, across all your
        sessions. Leave it off for no limit.
      </OnboardingStepHeader>

      <OnboardingSubhead icon={<Gauge className="h-[17px] w-[17px]" aria-hidden />}>
        Limits
      </OnboardingSubhead>

      <OnboardingCard className="mt-0">
        <SettingsControlRow
          label="Limit my tracks"
          description="Only affects you. Members have their own budgets."
        >
          <Switch
            checked={ceiling.enabled}
            disabled={saving}
            onCheckedChange={(enabled) => onChange(switchTrackCeiling(ceiling, enabled, capFloor))}
            aria-label="Limit my tracks"
          />
        </SettingsControlRow>
      </OnboardingCard>

      <OnboardingCard className={cn('mt-3', !ceiling.enabled && 'opacity-45')}>
        <OnboardingLimitRow
          label="Tracks per day"
          description="Resets at midnight in your timezone"
          value={ceiling.dailyTracks}
          unit="trk"
          step={trackYield * 5}
          min={capFloor}
          disabled={capsDisabled}
          onStep={(amount) => step('dailyTracks', amount, { min: capFloor })}
        />
        <OnboardingLimitRow
          label="Tracks per month"
          description="Resets on the 1st of each month"
          value={ceiling.monthlyTracks}
          unit="trk"
          step={trackYield * 25}
          min={capFloor}
          disabled={capsDisabled}
          onStep={(amount) => step('monthlyTracks', amount, { min: capFloor })}
        />
      </OnboardingCard>

      <OnboardingNote>
        {ceiling.enabled ? (
          <>
            <b className="font-semibold text-paper">
              Up to {note.tracks} tracks a {binding.window}
            </b>
            , about{' '}
            <span className="text-lamp">
              {note.hours > 0 ? `${note.hours} h ` : ''}
              {note.minutes} min
            </span>{' '}
            of new music. At a limit, sessions replay what they already made until it resets.
          </>
        ) : (
          <>
            <b className="font-semibold text-paper">No limit on your own tracks.</b> Tracks only
            generate while a session is running, and one nobody is listening to stops by itself.
          </>
        )}
      </OnboardingNote>

      <OnboardingSubhead icon={<Zap className="h-[17px] w-[17px]" aria-hidden />}>
        Speed
      </OnboardingSubhead>

      <OnboardingCard className="mt-0">
        <OnboardingLimitRow
          label="Generating at once"
          description={`Higher fills the queue faster and spends faster · ${trackYield} to ${concurrentMax}`}
          value={ceiling.concurrentTracks}
          unit="trk"
          step={trackYield}
          min={trackYield}
          max={concurrentMax}
          disabled={saving}
          onStep={(amount) =>
            step('concurrentTracks', amount, { min: trackYield, max: concurrentMax })
          }
        />
      </OnboardingCard>

      <OnboardingSpendActions
        label="Save and Continue"
        saving={saving}
        error={error}
        onCommit={() => void save(trackCeilingPatch(ceiling, tracksPerRequest))}
      />
    </section>
  );
}
