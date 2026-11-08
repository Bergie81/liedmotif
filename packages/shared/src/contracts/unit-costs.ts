// Unit costs: the Admin's own price per generated
// Track and per generated Cover, stored instance-wide in `app_settings` under
// `unitCosts`. USD to the cent, no currency setting, no history — a price change
// reprices the past. They feed nothing but Estimated cost readouts, which are
// Admin-only and hidden until a price is above 0.

import { z } from 'zod';

/**
 * A typo guard, not a judgement: no provider bills anywhere near $100 per Track
 * or Cover, so a price above it is a slipped decimal point.
 */
export const UNIT_COST_CEILING_USD = 100;

/**
 * Whole cents: `0.05` is a price, `0.005` is not — there is nothing to bill it
 * as. Rounding to cents and comparing is exact for every two-decimal double.
 */
function usdToTheCent() {
  return z
    .number()
    .min(0)
    .max(UNIT_COST_CEILING_USD)
    .refine((value) => Math.round(value * 100) / 100 === value, {
      message: 'Use whole cents (at most two decimals).',
    });
}

const unitCostsShape = {
  perTrackUsd: usdToTheCent(),
  perCoverUsd: usdToTheCent(),
};

export const unitCostsSchema = z.strictObject(unitCostsShape);
export type UnitCosts = z.infer<typeof unitCostsSchema>;

/**
 * The shipped providers' list prices, rounded up to the cent: a sunoapi.org call
 * is 12 credits at $0.005 for 2 Tracks ($0.03 each), and a 1024px cover from
 * `google/gemini-3.1-flash-image` is 1120 tokens at $60/M ($0.067). The margin
 * absorbs the text-LLM and prompt tokens. An Admin on other providers overwrites
 * both; zeroing both turns every readout off.
 */
export const DEFAULT_UNIT_COSTS: UnitCosts = { perTrackUsd: 0.04, perCoverUsd: 0.07 };

/** Update requests are partial patches; an omitted price keeps its value. */
export const updateUnitCostsRequestSchema = z.strictObject(unitCostsShape).partial();
export type UpdateUnitCostsRequest = z.infer<typeof updateUnitCostsRequestSchema>;

/** Whether any Estimated cost may be shown: at least one price above 0. */
export function unitCostsSet(costs: UnitCosts): boolean {
  return costs.perTrackUsd > 0 || costs.perCoverUsd > 0;
}

/** A count of Tracks and Covers — the unit every Admin-facing budget figure is in. */
export interface CostCounts {
  tracks: number;
  covers: number;
}

/**
 * Estimated cost: the counts at today's price, as one dollar figure rounded to
 * the cent so a binary-fraction product never reaches a readout.
 */
export function estimatedCostUsd(counts: CostCounts, costs: UnitCosts): number {
  const raw = counts.tracks * costs.perTrackUsd + counts.covers * costs.perCoverUsd;
  return Math.round(raw * 100) / 100;
}

const usdFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** US dollars to the cent: `$1,234.50`, except zero reads `$0` — cents on nothing are noise. */
export function formatUsd(amount: number): string {
  return amount === 0 ? '$0' : usdFormat.format(amount);
}
