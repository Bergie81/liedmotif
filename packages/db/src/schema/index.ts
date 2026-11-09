// Drizzle schema barrel — the single source of truth Drizzle Kit reads
// (`drizzle.config.ts` -> `schema: './src/schema/index.ts'`) and the typed shape
// the client factory binds (`createDb` -> `drizzle(pool, { schema })`).
//
// Better Auth owns the auth tables (`auth.ts`, generated + committed). The
// Liedmotif application tables reference Better Auth's `user.id` and are
// organized by domain area below. Enums, the shared `jsonb` TypeScript shapes,
// and the relational-query relations are exported too so both Drizzle Kit and
// consumers see the full schema. (`_columns.ts` is intentionally NOT re-exported:
// its builders are internal helpers, not part of the public surface.)

// Auth (Better Auth owns these).
export * from './auth';

// Shared building blocks.
export * from './enums';
export * from './types';

// Application tables, by domain.
export * from './settings';
export * from './providers';
export * from './profile';
export * from './invites';
export * from './people';
export * from './taste';
export * from './covers';
export * from './generation';
export * from './tracks';
export * from './playlists';
export * from './sessions';
export * from './session-covers';
export * from './feedback';
export * from './deletion';
export * from './voice';
export * from './analytics';
export * from './assistant';

// Relational-query relations (metadata only; no migration impact).
export * from './relations';
