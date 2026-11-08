// Cover images. Instance-global unless provenance names an owner: generated
// covers, the built-in placeholder, and uploads all live here, and `storageKey`
// addresses the object in storage. The `*Fit` JSON vectors and `publicPath` are
// inert — nothing reads or writes them; they carry their column defaults.
//
// Cover bytes are the one surface a member can grow without buying anything, so
// every write records its size here: the storage quota can only bound what it
// can count.

import { sql } from 'drizzle-orm';
import { boolean, index, integer, jsonb, pgTable, text } from 'drizzle-orm/pg-core';
import { createdAt, pk } from './_columns';
import { coverSourceType } from './enums';
import type { CoverMetadata } from './types';

export const coverImages = pgTable(
  'cover_images',
  {
    id: pk(),
    sourceType: coverSourceType('source_type').notNull(),
    storageProvider: text('storage_provider').notNull(),
    storageKey: text('storage_key').notNull(),
    /**
     * Bytes the cover occupies in storage, recorded by whoever wrote them — the
     * storage quota sums this column. Null is "unknown, not zero": a row written
     * before the column existed, or the built-in placeholder, whose bundled
     * asset is one fixed object per instance and cannot grow.
     */
    byteSize: integer('byte_size'),
    /**
     * Bytes of the derived tile rendition (`coverRenditionKey`), recorded when
     * the covers route renders it. A column of its own rather than a sum into
     * `byteSize`: the two are written by different paths at different times, and
     * restating one figure is idempotent where adding to a shared one is not.
     */
    renditionByteSize: integer('rendition_byte_size'),
    /**
     * True when the STORED bytes already carry the Liedmotif badge (legacy rows
     * written while storage compositing existed; originals were never retained)
     * or are brand art by design (the built-in placeholder). The album-art
     * rendition composites the badge at embed time exactly when this is false.
     * New writes leave the default: storage pipelines never composite the badge.
     */
    branded: boolean('branded').notNull().default(false),
    publicPath: text('public_path'),
    tags: jsonb('tags')
      .$type<CoverMetadata>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    activityFit: jsonb('activity_fit')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    moodFit: jsonb('mood_fit')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    genreFit: jsonb('genre_fit')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    energyFit: jsonb('energy_fit')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    colorFamily: text('color_family'),
    visualTheme: text('visual_theme'),
    provenance: jsonb('provenance').$type<CoverMetadata>(),
    attribution: jsonb('attribution').$type<CoverMetadata>(),
    licenseMetadata: jsonb('license_metadata').$type<CoverMetadata>(),
    createdAt: createdAt(),
  },
  (table) => [
    // The legacy generated-cover spend count scans generated rows by window.
    index('cover_images_generated_created_idx')
      .on(table.createdAt)
      .where(sql`${table.sourceType} = 'generated'`),
    // Uploaded covers are owned via provenance (no FK column); the uploaded-
    // history lists filter on the owner expression and order by recency.
    index('cover_images_uploaded_owner_idx')
      .on(sql`(${table.provenance} ->> 'ownerUserId')`, sql`${table.createdAt} desc`)
      .where(sql`${table.sourceType} = 'uploaded'`),
  ],
);
