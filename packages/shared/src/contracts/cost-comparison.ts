// Admin cost comparison: the one cross-user read in personal
// analytics. Counts only — Tracks and Covers per payer group, plus the Unit
// costs to price them with — so the strict objects are the privacy boundary: no
// title, prompt, cover, ranking or playback field can ride along.

import { z } from 'zod';
import { apiResponse, isoDatetimeSchema } from './common';
import { DEFAULT_LISTENING_RANGE, LISTENING_RANGES } from './listening';
import { unitCostsSchema } from './unit-costs';

const quantity = z.number().int().nonnegative();
const costCountsShape = { tracks: quantity, covers: quantity };

/** Possibly-paid spend, in the units every budget readout uses. */
export const costCountsSchema = z.strictObject(costCountsShape);

export const costComparisonQuerySchema = z.strictObject({
  range: z.enum(LISTENING_RANGES).default(DEFAULT_LISTENING_RANGE),
});

export const costComparisonSchema = z.strictObject({
  range: z.enum(LISTENING_RANGES),
  /** The instance budget timezone the period is cut in — not the viewer's reporting timezone. */
  timezone: z.string().min(1),
  /** Start of the range; null for all time. */
  from: isoDatetimeSchema.nullable(),
  /** Today's prices: the past is always priced at them. */
  unitCosts: unitCostsSchema,
  own: costCountsSchema,
  /** Every Member, current and former. `own` + `members` = `total`. */
  members: costCountsSchema,
  /** Spend whose owner's account is gone. `perMember` + `formerMembers` = `members`. */
  formerMembers: costCountsSchema,
  total: costCountsSchema,
  perMember: z.array(
    z.strictObject({ userId: z.string().min(1), name: z.string(), ...costCountsShape }),
  ),
});
export type CostComparisonData = z.infer<typeof costComparisonSchema>;
export const costComparisonResponseSchema = apiResponse(costComparisonSchema);
