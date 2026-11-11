import { defineConfig } from 'drizzle-kit';

// Drizzle Kit configuration (codebase-first: the TypeScript schema is the source
// of truth, and `drizzle-kit generate` emits versioned SQL migrations into
// `./drizzle`). `generate` runs offline; `migrate`/`studio` connect using
// `dbCredentials.url`.
//
// The schema barrel re-exports the committed Better Auth tables and the
// Liedmotif application tables, so anything added to `src/schema` is picked up
// here automatically.
//
// `url` falls back to the development database in `.env.example` (a
// non-secret) so offline `generate` never fails on a missing env var. Real
// `migrate`/`studio` runs use the `DATABASE_URL` from the environment.
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://liedmotif:liedmotif@localhost:5433/liedmotif_dev',
  },
  // Generate plain, reviewable SQL with descriptive prompts.
  verbose: true,
  strict: true,
});
