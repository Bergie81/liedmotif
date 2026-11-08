import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/node-postgres';

// Generation-only Better Auth configuration.
//
// Its ONLY job is to drive `@better-auth/cli generate`, which reads the adapter
// here and emits the Drizzle schema for the auth tables into
// `./src/schema/auth.ts` (committed). Better Auth owns those tables; Liedmotif app
// tables reference `user.id` rather than mirroring a user table.
//
// This is NOT the runtime auth instance — full auth wiring (email/password,
// sessions, route protection, the setup wizard) lives in the web app. Generation
// opens no database connection and never reads `secret`, so every value here is
// a hardcoded non-secret placeholder: this file reads no `process.env` and must
// not, so it can never pull a real credential into the generation step.
const db = drizzle('postgres://liedmotif:liedmotif@localhost:5432/liedmotif');

export const auth = betterAuth({
  // Placeholders: never used at generate time; the runtime instance has the real config.
  secret: 'generate-only-placeholder-not-a-real-secret',
  baseURL: 'http://localhost:2206',
  database: drizzleAdapter(db, { provider: 'pg' }),
  // Email/password is the auth method; declaring it here keeps the
  // generated schema in sync with how the tables will be used.
  emailAndPassword: { enabled: true },
});
