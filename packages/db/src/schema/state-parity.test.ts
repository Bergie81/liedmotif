// Parity guard: the canonical state literals in `@liedmotif/shared` MUST hold
// exactly the values of the live Drizzle `pgEnum` lists here. The two are
// declared independently on purpose — the DB owns the column value domain,
// `@liedmotif/shared` owns the transition semantics — so this test is what binds
// them and makes drift impossible. It reads the STATIC `pgEnum(...).enumValues`
// property, so it needs no database connection.
//
// Value SET, not order: a pgEnum's declaration order only affects `ORDER BY` on
// the enum type, which no query here does. Asserting order would turn a cosmetic
// reordering of a shared list (option order in the UI) into a `DROP TYPE` /
// `CREATE TYPE` migration on live tables, buying nothing.
//
// This test lives in `packages/db` (db → shared is the allowed dependency
// direction; shared never depends on db). If this ever fails, do NOT "fix" it by
// editing only one side: a deliberate enum change must update the `pgEnum` AND the
// shared literal AND ship the resulting Drizzle migration.

import {
  ACTIVITY_SESSION_STATUSES,
  PROVIDER_NORMALIZED_STATUSES,
  QUEUE_ITEM_STATES,
  SESSION_END_REASONS,
  SESSION_GENERATION_STATUSES,
  SESSION_MODES,
  TRACK_STATUSES,
} from '@liedmotif/shared';
import { describe, expect, it } from 'vitest';
import {
  activitySessionStatus,
  providerNormalizedStatus,
  queueItemState,
  sessionEndReason,
  sessionGenerationStatus,
  sessionMode,
  trackStatus,
} from './enums';

describe('state-literal ↔ pgEnum parity', () => {
  const cases: ReadonlyArray<{
    name: string;
    shared: readonly string[];
    db: readonly string[];
  }> = [
    {
      name: 'activitySessionStatus',
      shared: ACTIVITY_SESSION_STATUSES,
      db: activitySessionStatus.enumValues,
    },
    { name: 'queueItemState', shared: QUEUE_ITEM_STATES, db: queueItemState.enumValues },
    {
      name: 'providerNormalizedStatus',
      shared: PROVIDER_NORMALIZED_STATUSES,
      db: providerNormalizedStatus.enumValues,
    },
    { name: 'trackStatus', shared: TRACK_STATUSES, db: trackStatus.enumValues },
    {
      name: 'sessionEndReason',
      shared: SESSION_END_REASONS,
      db: sessionEndReason.enumValues,
    },
    {
      name: 'sessionGenerationStatus',
      shared: SESSION_GENERATION_STATUSES,
      db: sessionGenerationStatus.enumValues,
    },
    { name: 'sessionMode', shared: SESSION_MODES, db: sessionMode.enumValues },
  ];

  for (const { name, shared, db } of cases) {
    it(`${name}: shared literal array holds exactly the pgEnum values`, () => {
      // Sorted compare catches a missing, extra, or renamed value — the drift that
      // needs a migration — without pinning the declaration order.
      expect([...shared].sort()).toEqual([...db].sort());
    });
  }
});
