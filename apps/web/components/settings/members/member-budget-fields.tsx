'use client';

// The budget rows (in Tracks and Covers): the four Rolling windows on steppers,
// which the Pool panel shows on their own, and the two One-time totals as typed
// numbers. The Member forms — invite and per-Member editor — show them under
// one shared kind switch, so the two never drift in order, copy, or which
// fields a kind shows.

import {
  estimatedCostUsd,
  formatUsd,
  unitCostsSet,
  type BudgetKind,
  type CostCounts,
  type UnitCosts,
} from '@liedmotif/shared';
import { Stepper } from '@/components/ui/controls';
import {
  segmentedListClass,
  segmentedTriggerClass,
  stepperValueClass,
} from '@/components/ui/design-system';
import { normalizeTracksPerRequest, stepNonNegativeWholeValue } from '@/lib/track-units';
import { PricedQuantity, pricedStepperClass } from '../cost-readout';
import { SettingsControlRow } from '../settings-ui';
import {
  BUDGET_KIND_ORDER,
  budgetKindLabel,
  formEstimateCounts,
  memberBudgetFieldMax,
  type MemberBudgetErrors,
  type MemberBudgetField,
  type MemberBudgetFormValues,
} from './members-admin-model';

interface BudgetRow {
  field: MemberBudgetField;
  label: string;
  unit: 'Tracks' | 'Covers';
}

interface WindowRow extends BudgetRow {
  /** Step size in display units; track fields scale by the provider yield. */
  step: (trackYield: number) => number;
}

const WINDOW_ROWS: WindowRow[] = [
  { field: 'dailyTracks', label: 'Tracks per day', unit: 'Tracks', step: (y) => y },
  { field: 'monthlyTracks', label: 'Tracks per month', unit: 'Tracks', step: (y) => y * 5 },
  { field: 'coversPerDay', label: 'Covers per day', unit: 'Covers', step: () => 1 },
  { field: 'coversPerMonth', label: 'Covers per month', unit: 'Covers', step: () => 5 },
];

/** The One-time totals are typed, not stepped: a total is a number the Admin has in mind. */
const TOTAL_ROWS: BudgetRow[] = [
  { field: 'totalTracks', label: 'Tracks in total', unit: 'Tracks' },
  { field: 'totalCovers', label: 'Covers in total', unit: 'Covers' },
];

const totalInputClass =
  'h-9 w-[88px] rounded-[11px] border border-line-2 bg-[var(--field-bg)] shadow-[var(--shadow-field)] light:focus:bg-panel px-3 text-right font-mono text-[13px] text-paper focus:border-lamp/60 focus:shadow-[0_0_0_3px_var(--lamp-glow)] disabled:opacity-35';

interface BudgetFieldsProps {
  values: MemberBudgetFormValues;
  errors: MemberBudgetErrors;
  disabled: boolean;
  unitCosts: UnitCosts;
  tracksPerCall: number;
  onChange: (field: MemberBudgetField, value: string) => void;
}

/**
 * The two One-time totals, typed rather than stepped. `counts` is the priced
 * estimate of the saved totals, null while there is none to show.
 */
function MemberBudgetTotalFields({
  values,
  errors,
  disabled,
  onChange,
  unitCosts,
  counts,
}: BudgetFieldsProps & { counts: CostCounts | null }) {
  return (
    <>
      {TOTAL_ROWS.map(({ field, label, unit }) => {
        const error = errors[field];
        const estimate = counts ? (
          <PricedQuantity
            quantity={unit === 'Tracks' ? counts.tracks : counts.covers}
            unit={unit}
            costs={unitCosts}
            costFirst
          />
        ) : undefined;
        return (
          <SettingsControlRow
            key={field}
            label={label}
            description={error ? <span className="text-warn">{error}</span> : estimate}
          >
            <span className="inline-flex items-center gap-2">
              <input
                type="text"
                inputMode="numeric"
                aria-label={label}
                aria-invalid={error ? true : undefined}
                value={values[field]}
                maxLength={6}
                disabled={disabled}
                onChange={(event) => onChange(field, event.target.value)}
                className={totalInputClass}
              />
              <span className={`${stepperValueClass} min-w-0`}>{unit}</span>
            </span>
          </SettingsControlRow>
        );
      })}
    </>
  );
}

/** The four Rolling window steppers, which the Pool panel also shows on their own. */
export function MemberBudgetFields({
  values,
  errors,
  disabled,
  tracksPerCall,
  unitCosts,
  onChange,
}: BudgetFieldsProps) {
  const trackYield = normalizeTracksPerRequest(tracksPerCall);
  return (
    <>
      {WINDOW_ROWS.map(({ field, label, unit, step }) => {
        const error = errors[field];
        const current = Number(values[field]);
        const max = memberBudgetFieldMax(field, tracksPerCall);
        return (
          <SettingsControlRow
            key={field}
            label={label}
            description={error ? <span className="text-warn">{error}</span> : undefined}
          >
            <Stepper
              className={pricedStepperClass}
              value={<PricedQuantity quantity={current} unit={unit} costs={unitCosts} costFirst />}
              onDecrement={() =>
                onChange(field, stepNonNegativeWholeValue(values[field], -step(trackYield), max))
              }
              onIncrement={() =>
                onChange(field, stepNonNegativeWholeValue(values[field], step(trackYield), max))
              }
              decrementLabel={`Decrease ${label}`}
              incrementLabel={`Increase ${label}`}
              canDecrement={!disabled && Number.isFinite(current) && current > 0}
              canIncrement={!disabled && Number.isFinite(current) && current < max}
            />
          </SettingsControlRow>
        );
      })}
    </>
  );
}

/**
 * The kind switch over the fields that kind reads — the one budget editor both
 * Member forms render. One-time comes first: it is the common case (one total
 * to test with) and the default on a new invite.
 */
export function MemberBudgetKindFields({
  kind,
  onKindChange,
  ...fields
}: BudgetFieldsProps & {
  kind: BudgetKind;
  onKindChange: (kind: BudgetKind) => void;
}) {
  const counts = unitCostsSet(fields.unitCosts)
    ? formEstimateCounts(kind, fields.values, fields.tracksPerCall)
    : null;
  return (
    <>
      <div className={segmentedListClass} role="group" aria-label="Budget kind">
        {BUDGET_KIND_ORDER.map((option) => {
          const active = option === kind;
          return (
            <button
              key={option}
              type="button"
              data-state={active ? 'active' : 'inactive'}
              aria-pressed={active}
              disabled={fields.disabled}
              onClick={() => onKindChange(option)}
              className={segmentedTriggerClass}
            >
              {budgetKindLabel(option)}
            </button>
          );
        })}
      </div>
      <p className="mb-1 mt-2 text-[12.5px] leading-relaxed text-dim">
        {kind === 'oneTime'
          ? 'One total that never renews. Raise it to top up.'
          : 'Caps that reset daily and at the start of each calendar month.'}
      </p>
      {kind === 'oneTime' ? (
        <MemberBudgetTotalFields {...fields} counts={counts} />
      ) : (
        <MemberBudgetFields {...fields} />
      )}
      {counts ? (
        <p className="mt-2 text-right text-[12.5px] text-dim">
          ≈ {formatUsd(estimatedCostUsd(counts, fields.unitCosts))}{' '}
          {kind === 'oneTime' ? 'for the total' : 'per month at most'}, estimated
        </p>
      ) : null}
    </>
  );
}
