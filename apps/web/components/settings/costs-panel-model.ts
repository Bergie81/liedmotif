// The pure shapes behind the Unit costs panel: the stored
// prices as input strings, and the typed strings back to the patch the route
// accepts.

import { unitCostsSchema, type UnitCosts } from '@liedmotif/shared';

export type UnitCostsFormValues = Record<keyof UnitCosts, string>;
export type UnitCostsErrors = Partial<Record<keyof UnitCosts, string>>;

/** Stored prices as the strings the inputs edit. `0` shows as "0", never "$0". */
export function unitCostsFormValues(costs: UnitCosts): UnitCostsFormValues {
  return { perTrackUsd: String(costs.perTrackUsd), perCoverUsd: String(costs.perCoverUsd) };
}

const UNIT_COST_MESSAGES: Record<string, string> = {
  too_small: 'Must be 0 or more.',
  too_big: 'Too high — check the decimal point.',
};

/**
 * Typed prices → the patch the route accepts, validated against the shared
 * schema so the inline errors say what the server would. A decimal comma is
 * accepted: the Admin types a price, not a locale.
 */
export function parseUnitCostsForm(
  values: UnitCostsFormValues,
): { ok: true; patch: UnitCosts } | { ok: false; errors: UnitCostsErrors } {
  const errors: UnitCostsErrors = {};
  const numbers: Record<string, number> = {};
  for (const field of ['perTrackUsd', 'perCoverUsd'] as const) {
    const text = values[field].trim().replace(',', '.');
    const value = text === '' ? Number.NaN : Number(text);
    if (!Number.isFinite(value)) errors[field] = 'Enter a price in dollars.';
    else numbers[field] = value;
  }
  const parsed = unitCostsSchema.safeParse(numbers);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0] as keyof UnitCosts;
      errors[field] ??= UNIT_COST_MESSAGES[issue.code] ?? issue.message;
    }
  }
  // A field that did not parse as a number is missing from `numbers`, so the
  // schema refuses it too: one failure path, one place that collects messages.
  if (!parsed.success) return { ok: false, errors };
  return { ok: true, patch: parsed.data };
}
