// Manual taste profile (one per owner). Feeds into the Style Snapshot at session
// start. JSON list columns default to an empty array so the editor can patch
// individual facets without null juggling.

import { sql } from 'drizzle-orm';
import { jsonb, pgTable, text, uniqueIndex } from 'drizzle-orm/pg-core';
import { createdAt, ownerUserId, pk, updatedAt } from './_columns';

export const tasteProfiles = pgTable(
  'taste_profiles',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    favoriteGenres: jsonb('favorite_genres')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dislikedGenres: jsonb('disliked_genres')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    preferredMoods: jsonb('preferred_moods')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    dislikedMoods: jsonb('disliked_moods')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    vocalPreference: text('vocal_preference'),
    languagePreference: text('language_preference'),
    energyPreference: jsonb('energy_preference').$type<Record<string, unknown>>(),
    explicitContentPreference: text('explicit_content_preference'),
    commonActivities: jsonb('common_activities')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    freeformSummary: text('freeform_summary'),
    sourceSummary: jsonb('source_summary').$type<Record<string, unknown>>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // One taste profile per owner.
    uniqueIndex('taste_profiles_owner_user_id_unique').on(table.ownerUserId),
  ],
);
