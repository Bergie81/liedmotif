// Provider credentials + usage/quota events.
//
// Credentials are instance-owned and admin-only; secrets are encrypted at rest
// and never serialized to the client (the credentials module owns the crypto —
// this models the columns). `ownerUserId` is NULLABLE: a null owner is an instance-level
// credential, the only kind the credentials module reads or writes; the column
// leaves room for owner-/user-scoped credentials without a rewrite.

import {
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { createdAt, pk, updatedAt, userId } from './_columns';
import { user } from './auth';
import { credentialSource, providerType } from './enums';
import type { EncryptedSecret, ProviderConfig } from './types';

export const providerCredentials = pgTable(
  'provider_credentials',
  {
    id: pk(),
    // Nullable owner: null = instance-level credential.
    ownerUserId: text('owner_user_id').references(() => user.id, { onDelete: 'cascade' }),
    providerType: providerType('provider_type').notNull(),
    // `providerKey` is open vocabulary (suno, openai-compatible, openrouter,
    // ollama, local-fs, …) — text, not an enum, so a new adapter
    // never needs an `ALTER TYPE`.
    providerKey: text('provider_key').notNull(),
    displayName: text('display_name').notNull(),
    // Null when env-sourced: the secret then lives in the environment, not the DB.
    encryptedSecret: jsonb('encrypted_secret').$type<EncryptedSecret>(),
    config: jsonb('config').$type<ProviderConfig>(),
    source: credentialSource('source').notNull(),
    lastValidatedAt: timestamp('last_validated_at', { withTimezone: true }),
    validationStatus: text('validation_status'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    // At most one instance-level (owner-less) credential per provider, so the
    // setup/settings upsert can never create duplicate instance rows.
    uniqueIndex('provider_credentials_instance_provider_unique')
      .on(table.providerType, table.providerKey)
      .where(sql`${table.ownerUserId} is null`),
    // Single-LLM invariant at the database boundary: at most ONE
    // owner-less `llm` row TOTAL (any provider key), so even racing saves can
    // never recreate the multi-row "which LLM is configured?" ambiguity — the
    // loser of the race fails on this index instead of persisting a second LLM.
    uniqueIndex('provider_credentials_instance_llm_singleton')
      .on(table.providerType)
      .where(sql`${table.ownerUserId} is null and ${table.providerType} = 'llm'`),
    // RI cascade probe on user delete.
    index('provider_credentials_owner_idx').on(table.ownerUserId),
  ],
);

/**
 * Append-only spend ledger. Today the worker's paid-submit path
 * appends one row per issued MUSIC generation call (`generation/usage-repo`) —
 * best-effort diagnostics, never limit enforcement (limits count `provider_jobs`).
 * Carries `userId`, `providerType`, `providerKey`, and `operation` from day one
 * (forward-compat for per-user quotas). `estimatedCost` is a provider-native
 * scalar (e.g. credits — no invented dollar amounts); it and the credit
 * before/after snapshots stay null until credit diagnostics land, and
 * non-music operations (LLM expansion, covers) start writing rows there too.
 */
export const usageEvents = pgTable(
  'usage_events',
  {
    id: pk(),
    userId: userId(),
    providerType: providerType('provider_type').notNull(),
    providerKey: text('provider_key').notNull(),
    operation: text('operation').notNull(),
    units: integer('units').notNull(),
    estimatedCost: doublePrecision('estimated_cost'),
    providerCreditsBefore: integer('provider_credits_before'),
    providerCreditsAfter: integer('provider_credits_after'),
    metadata: jsonb('metadata'),
    createdAt: createdAt(),
  },
  (table) => [
    // RI cascade probe on user delete.
    index('usage_events_user_id_idx').on(table.userId),
    // Retention prune (`pruneEventTables`) — the only age-ordered read there is.
    index('usage_events_created_at_idx').on(table.createdAt),
  ],
);
