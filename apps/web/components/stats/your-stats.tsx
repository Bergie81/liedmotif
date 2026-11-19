'use client';

import { useMemo, useState } from 'react';
import type { ListeningStatsData } from '@liedmotif/shared';
import {
  SettingsCard,
  SettingsControlRow,
  SettingsFootnote,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { secondaryButtonClass } from '@/components/ui/form-styles';
import { clearListeningHistory } from '@/lib/http/api-client';
import {
  coverageNote,
  dailySeries,
  formatListeningTime,
  generationParts,
  generationSummary,
  genreRows,
  rankColor,
  trackRows,
  type GenreRow,
} from './your-stats-model';
import { MostPlayed } from './most-played';
import { DailyListeningChart, GenreDial, PartsRing, type ChartPart } from './stats-charts';
import { emptyClass, Figure, figureValueClass, RangedBody, ReadingRow } from './stats-parts';
import type { RangedRead } from './use-ranged-read';

function MostListenedGenres({ rows }: { rows: GenreRow[] }) {
  const top = rows[0];
  if (!top) {
    return <p className={emptyClass}>No listening recorded in this period.</p>;
  }
  return (
    <>
      {top.key ? (
        <p className="mb-4">
          <span className={`block ${figureValueClass}`}>{top.label}</span>
          <span className="mt-2 block font-mono text-[11px] tracking-[0.05em] text-muted">
            {top.share}% of your listening, {top.time}
          </span>
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-6">
        <div className="mx-auto w-[200px] max-w-full shrink-0">
          <GenreDial rows={rows} />
        </div>
        <ol className="min-w-[160px] flex-1">
          {rows.map((row, rank) => (
            <ReadingRow
              key={row.key}
              swatch={rankColor('var(--lamp-fill)', rank, rows.length)}
              label={row.label}
              detail={row.time}
              value={`${row.share}%`}
            />
          ))}
        </ol>
      </div>
    </>
  );
}

function Generation({ stats }: { stats: ListeningStatsData }) {
  const parts = useMemo<ChartPart[]>(() => {
    const { heard, neverHeard, unknown } = generationParts(stats.generation);
    return [
      { key: 'heard', label: 'Heard', value: heard, color: 'lamp' },
      { key: 'never-heard', label: 'Never heard', value: neverHeard, color: 'second' },
      { key: 'unknown', label: 'Unknown', value: unknown, color: 'track' },
    ];
  }, [stats.generation]);
  const summary = generationSummary(stats);
  if (summary.empty) {
    return <p className={emptyClass}>No generation recorded in this period.</p>;
  }
  const { generatedTracks, failedAttempts } = stats.generation;
  return (
    <>
      <PartsRing
        total={generatedTracks.toLocaleString('en-US')}
        totalLabel="generated"
        parts={parts}
        extra={[{ label: 'Failed attempts', value: failedAttempts.toLocaleString('en-US') }]}
      />
      <SettingsFootnote>
        Tracks count once, when they first became playable, and stay counted after you delete them.{' '}
        {summary.notes.join(' ')}
      </SettingsFootnote>
    </>
  );
}

export function YourStats({ read }: { read: RangedRead<ListeningStatsData> }) {
  const { data: stats, range, loading, error, load } = read;

  const [confirmingClear, setConfirmingClear] = useState(false);
  const clearHistory = async () => {
    await load(range, async () => {
      const cleared = await clearListeningHistory();
      return cleared.ok ? null : 'Your listening history could not be cleared.';
    });
    setConfirmingClear(false);
  };

  // Today is read once per answer, so the series' last day matches the figures above it.
  const days = useMemo(() => dailySeries(stats, new Date()), [stats]);
  // Stable rows keep a chart from being rebuilt by a render that changed nothing it draws.
  const tracks = useMemo(() => trackRows(stats), [stats]);
  const genres = useMemo(() => genreRows(stats), [stats]);
  const nothingYet = stats.listenedMs === 0 && stats.qualifyingPlays === 0;

  return (
    <>
      <div className="mt-6">
        <SettingsSection title="Listening">
          <SettingsCard>
            <RangedBody
              error={error}
              loading={loading}
              loadingLabel="Loading your stats"
              onRetry={() => void load(range)}
            >
              <div className="flex flex-wrap gap-6">
                <Figure label="Listening time" value={formatListeningTime(stats.listenedMs)} />
                <Figure label="Plays" value={stats.qualifyingPlays.toLocaleString('en-US')} />
                <Figure label="Tracks" value={stats.uniqueTracks.toLocaleString('en-US')} />
              </div>
              {nothingYet ? (
                <p className="mt-4 text-[13px] leading-relaxed text-muted">
                  Nothing recorded in this period yet. Play one of your Sessions and your listening
                  shows up here.
                </p>
              ) : (
                <div className="mt-6">
                  <h3 className="mb-2 font-mono text-[11px] tracking-[0.05em] text-muted">
                    Listening time per day{days.length < 7 ? '' : `, last ${days.length} days`}
                  </h3>
                  <DailyListeningChart points={days} />
                </div>
              )}
              <SettingsFootnote>
                A play counts after 30 seconds, or half of a track shorter than a minute. Listening
                time counts every second the app is playing — not while paused, buffering, or
                silenced in the app. {coverageNote(stats)}
              </SettingsFootnote>
            </RangedBody>
          </SettingsCard>
        </SettingsSection>

        {error || loading ? null : (
          <>
            <SettingsSection title="Most played">
              <SettingsCard>
                <MostPlayed rows={tracks} />
              </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Most listened genres">
              <SettingsCard>
                <MostListenedGenres rows={genres} />
                <SettingsFootnote>By listening time, short listens included.</SettingsFootnote>
              </SettingsCard>
            </SettingsSection>
            <SettingsSection title="Generation">
              <SettingsCard>
                <Generation stats={stats} />
              </SettingsCard>
            </SettingsSection>
          </>
        )}

        <SettingsSection title="History">
          <SettingsCard>
            <SettingsControlRow
              label="Clear listening history"
              description="Removes your listening time, plays, rankings and learned taste, and starts recording afresh. Your music, generated totals and costs stay."
            >
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={loading}
                onClick={() => setConfirmingClear(true)}
              >
                Clear
              </button>
            </SettingsControlRow>
          </SettingsCard>
        </SettingsSection>
      </div>

      {confirmingClear ? (
        <ConfirmDialog
          heading="Clear listening history"
          body="Every listening record is removed for good: listening time, plays, most played, genres and learned taste restart from now, and tracks generated so far can no longer be told apart as heard or never heard. Your music, Playlists, generated totals and costs are not touched."
          confirmLabel="Clear history"
          onConfirm={clearHistory}
          onClose={() => setConfirmingClear(false)}
        />
      ) : null}
    </>
  );
}
