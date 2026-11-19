import type { UnitCosts } from '@liedmotif/shared';
import { SettingsUsageMeter } from '@/components/settings/settings-ui';
import type { BudgetUsage, BudgetWindow } from '@/lib/budget/my-budget-model';
import { PricedQuantity } from './cost-readout';

interface RollingTrackLabels {
  day: string;
  month: string;
}

const DEFAULT_TRACK_LABELS: RollingTrackLabels = { day: 'Today', month: 'This month' };
export const MEMBER_TRACK_LABELS: RollingTrackLabels = {
  day: 'Tracks today',
  month: 'Tracks this month',
};

/** One-time budgets show what remains; rolling budgets show what each window used. */
export function BudgetUsageMeters({
  usage,
  trackLabels = DEFAULT_TRACK_LABELS,
  unitCosts,
}: {
  usage: BudgetUsage;
  trackLabels?: RollingTrackLabels;
  /** Supplied only by the Admin's Members page. */
  unitCosts?: UnitCosts;
}) {
  const oneTime = usage.kind === 'oneTime';
  const rows: { label: string; unit: 'Tracks' | 'Covers'; window: BudgetWindow }[] = oneTime
    ? [
        { label: 'Tracks', unit: 'Tracks', window: usage.tracks },
        { label: 'Covers', unit: 'Covers', window: usage.covers },
      ]
    : [
        { label: trackLabels.day, unit: 'Tracks', window: usage.figures.tracksDay },
        { label: trackLabels.month, unit: 'Tracks', window: usage.figures.tracksMonth },
        { label: 'Covers today', unit: 'Covers', window: usage.figures.coversDay },
        { label: 'Covers this month', unit: 'Covers', window: usage.figures.coversMonth },
      ];
  return (
    <>
      {rows.map(({ label, unit, window }) => (
        <SettingsUsageMeter
          key={label}
          label={label}
          used={window.used}
          limit={window.limit}
          suffix={unit}
          readout={
            <>
              <PricedQuantity
                quantity={oneTime ? window.remaining : window.used}
                limit={window.limit}
                unit={unit}
                costs={unitCosts}
                costFirst
              />
              {oneTime ? ' left' : null}
            </>
          }
        />
      ))}
    </>
  );
}
