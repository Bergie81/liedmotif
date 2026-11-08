import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { createdAt, ownerUserId, pk, updatedAt } from './_columns';

/** Owner-scoped People used for exact-name matching, cover references, and lyric context. */
export const people = pgTable(
  'people',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    role: text('role').notNull(),
    name: text('name').notNull(),
    nameMatchKey: text('name_match_key').notNull(),
    about: text('about').notNull().default(''),
    sortOrder: integer('sort_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    check('people_role_valid', sql`${table.role} in ('owner', 'ordinary')`),
    check('people_sort_order_nonnegative', sql`${table.sortOrder} >= 0`),
    uniqueIndex('people_owner_name_match_key_unique').on(table.ownerUserId, table.nameMatchKey),
    uniqueIndex('people_one_owner_profile')
      .on(table.ownerUserId)
      .where(sql`${table.role} = 'owner'`),
    uniqueIndex('people_owner_id_unique').on(table.ownerUserId, table.id),
    index('people_owner_sort_order_idx').on(table.ownerUserId, table.sortOrder, table.id),
  ],
);

/** Processed private portrait references owned by exactly one Person. */
export const personReferencePhotos = pgTable(
  'person_reference_photos',
  {
    id: pk(),
    ownerUserId: ownerUserId(),
    personId: uuid('person_id').notNull(),
    storageProvider: text('storage_provider').notNull(),
    storageKey: text('storage_key').notNull(),
    mediaType: text('media_type').notNull(),
    originalFilename: text('original_filename'),
    byteSize: integer('byte_size').notNull(),
    width: integer('width'),
    height: integer('height'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    foreignKey({
      columns: [table.ownerUserId, table.personId],
      foreignColumns: [people.ownerUserId, people.id],
      name: 'person_reference_photos_owner_person_fk',
    }).onDelete('cascade'),
    uniqueIndex('person_reference_photos_storage_key_unique').on(table.storageKey),
    index('person_reference_photos_owner_person_created_idx').on(
      table.ownerUserId,
      table.personId,
      table.createdAt,
      table.id,
    ),
  ],
);
