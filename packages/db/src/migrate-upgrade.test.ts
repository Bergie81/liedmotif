import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COVER_STYLES } from '@liedmotif/shared';
import { createDb, createPool, type Database, type Pool } from './index';
import { MIGRATIONS_DIR, runDrizzleMigrations } from './migrate';
import { assertSafeTestDatabase } from './test-support';

// Migration-UPGRADE test (CI job `migration-upgrade`): unlike the migrate-from-clean
// suite, this stands up the PRE-BLENDING schema (every migration up to 0013), seeds
// data the way the app wrote it BEFORE session blending — tracks generated before
// the migration, and a session that went through a pre-blending Change Vibe
// (snapshot replaced in place, nothing else) — then applies the blending
// migrations and asserts the legacy rows read exactly
// as the contracts require: NULL blend identity (→ plain edge, always) and
// `pending` analysis provenance.

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** The last migration that predates session blending. */
const PRE_PLAN_LAST_TAG = '0013_striped_celestials';
const BUFFER_SETTING_MIGRATION_TAG = '0041_buffer-enabled-setting';

interface JournalEntry {
  tag: string;
}

/** The committed migration tags in apply order (from Drizzle's journal). */
async function migrationTags(): Promise<string[]> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, 'meta', '_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  return journal.entries.map((entry) => entry.tag);
}

/** Apply one committed migration file statement-by-statement (no bookkeeping). */
async function applyMigration(pool: Pool, tag: string): Promise<void> {
  const sqlText = await readFile(path.join(MIGRATIONS_DIR, `${tag}.sql`), 'utf8');
  for (const statement of sqlText.split('--> statement-breakpoint')) {
    const trimmed = statement.trim();
    if (trimmed) await pool.query(trimmed);
  }
}

describeIfDb('migration upgrade from the pre-blending schema', () => {
  let pool: Pool;
  let db: Database;
  let seeded: {
    prePlanTrackId: string;
    postVibeTrackId: string;
    sessionId: string;
    prePlanRequestId: string;
    postVibeRequestId: string;
    explicitPresetSessionId: string;
    coverLedgerId: string;
    legacyReferenceId: string;
    cinematicSessionId: string;
    studioCandidateId: string;
    tombstonedStudioCandidateId: string;
    retiredLaneSessionId: string;
    retiredLaneCandidateId: string;
  };

  beforeAll(async () => {
    assertSafeTestDatabase(testDatabaseUrl);
    pool = createPool(testDatabaseUrl, { applicationName: 'liedmotif-migrate-upgrade', max: 2 });
    db = createDb(pool);

    // Pristine reset, then stand up the PRE-BLENDING schema only.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    const tags = await migrationTags();
    const cut = tags.indexOf(PRE_PLAN_LAST_TAG);
    expect(cut).toBeGreaterThan(-1);
    for (const tag of tags.slice(0, cut + 1)) await applyMigration(pool, tag);

    // --- Seed pre-blending data exactly as the app wrote it. -----------------
    await pool.query(
      `insert into "user" (id, name, email, updated_at) values ('owner-1', 'Owner', 'owner@example.test', now())`,
    );
    await pool.query(
      `insert into user_profiles (owner_user_id, about)
       values ('owner-1', '  Weekend trail runs with Tina.  ')`,
    );
    const legacyReferenceId = crypto.randomUUID();
    await pool.query(
      `insert into profile_cover_references
         (id, owner_user_id, storage_provider, storage_key, media_type, description, byte_size)
       values ($1, 'owner-1', 'local-fs', $2, 'image/webp', 'Owner portrait', 128)`,
      [legacyReferenceId, `profile-references/owner-1/${legacyReferenceId}.webp`],
    );
    const session = await pool.query(
      `insert into activity_sessions (owner_user_id, status, session_style_snapshot)
       values ('owner-1', 'active', '{"stylePrompt":"old vibe","bpm":96,"key":"A minor"}')
       returning id`,
    );
    const sessionId = session.rows[0].id as string;

    // A track generated before the migration (and before any Change Vibe).
    const seedRequestAndTrack = async (
      style: string,
      providerTrackId: string,
      bpm: number | null,
    ) => {
      const request = await pool.query(
        `insert into generation_requests (owner_user_id, activity_session_id, source, provider_type, provider_key, status, style_prompt)
         values ('owner-1', $1, 'controls', 'music', 'mock', 'submitting', $2) returning id`,
        [sessionId, style],
      );
      const requestId = request.rows[0].id as string;
      const job = await pool.query(
        `insert into provider_jobs (generation_request_id, provider_type, provider_key, submit_state, normalized_status, provider_task_id)
         values ($1, 'music', 'mock', 'submitted', 'ready', $2) returning id`,
        [requestId, `task-${providerTrackId}`],
      );
      const track = await pool.query(
        `insert into tracks (owner_user_id, generation_request_id, provider_job_id, provider_key, provider_track_id, prompt, status, bpm_estimate)
         values ('owner-1', $1, $2, 'mock', $3, 'old vibe prompt', 'ready', $4) returning id`,
        [requestId, job.rows[0].id, providerTrackId, bpm],
      );
      return { requestId, trackId: track.rows[0].id as string };
    };

    const prePlan = await seedRequestAndTrack('old vibe style', 'pre-vibe', 96);
    // The stream-first provider flow used to leave the canonical Track duration
    // null even after the later final asset recorded it. Seed that exact legacy
    // shape so the upgrade must repair an existing library, not only new Tracks.
    await pool.query(
      `insert into track_audio_assets
         (track_id, asset_type, storage_provider, duration_seconds, is_playable)
       values ($1, 'provider_final', 'mock', 168, false)`,
      [prePlan.trackId],
    );

    // A pre-blending Change Vibe: the snapshot is replaced IN PLACE — that
    // schema has no revision to bump, and old-vibe rows keep pointing at it.
    await pool.query(
      `update activity_sessions set session_style_snapshot = '{"stylePrompt":"new vibe","bpm":70,"key":"C major"}' where id = $1`,
      [sessionId],
    );
    const postVibe = await seedRequestAndTrack('new vibe style', 'post-vibe', 70);
    await pool.query(
      `update activity_sessions
       set cover_style = 'auto', cover_style_hint = 'torn paper collage'
       where id = $1`,
      [sessionId],
    );
    const explicitPreset = await pool.query(
      `insert into activity_sessions
         (owner_user_id, status, cover_style, cover_style_hint, cover_style_hint_normalized)
       values ('owner-1', 'stopped', 'photographic', 'legacy conflicting hint', 'legacy normalized hint')
       returning id`,
    );

    // A session and default-style setting on the later-retired `cinematic` lane.
    const cinematicSession = await pool.query(
      `insert into activity_sessions (owner_user_id, status, cover_style)
       values ('owner-1', 'stopped', 'cinematic')
       returning id`,
    );
    await pool.query(
      `insert into app_settings (key, value)
       values ('coverArt', '{"defaultStyle":"cinematic","customStyleDefinition":""}')`,
    );

    // --- Apply the blending migrations (everything after the cut). ------------
    const coverLedgerId = crypto.randomUUID();
    const studioBatchId = crypto.randomUUID();
    const studioCandidateId = crypto.randomUUID();
    const tombstonedStudioCandidateId = crypto.randomUUID();
    let retiredLaneSessionId = '';
    const retiredLaneBatchId = crypto.randomUUID();
    const retiredLaneCandidateId = crypto.randomUUID();
    for (const tag of tags.slice(cut + 1)) {
      if (tag === BUFFER_SETTING_MIGRATION_TAG) {
        await pool.query(
          `insert into "user" (id, name, email, updated_at) values
             ('buffer-off', 'Buffer Off', 'buffer-off@example.test', now()),
             ('buffer-one', 'Buffer One', 'buffer-one@example.test', now()),
             ('buffer-five', 'Buffer Five', 'buffer-five@example.test', now()),
             ('buffer-missing', 'Buffer Missing', 'buffer-missing@example.test', now())`,
        );
        await pool.query(
          `insert into user_settings (owner_user_id, key, value) values
             ('buffer-off', 'generation', '{"bufferAheadTracks":0,"defaultLanguage":"German"}'),
             ('buffer-one', 'generation', '{"bufferAheadTracks":1,"defaultLanguage":"auto"}'),
             ('buffer-five', 'generation', '{"bufferAheadTracks":5,"defaultLanguage":"English"}'),
             ('buffer-missing', 'generation', '{"defaultLanguage":"French"}')`,
        );
      }
      await applyMigration(pool, tag);
      if (tag === '0035_retire-cinematic-cover-style') {
        // A selection recorded while the abstract/collage/retro/surreal/futuristic
        // lanes were still selectable; the next migration must fold it into its
        // nearest kept lane. The Studio draft is seeded on those lanes so the
        // fold migrations run over real rows before the Studio drop removes them.
        const retired = await pool.query(
          `insert into activity_sessions (owner_user_id, status, cover_style)
           values ('owner-1', 'stopped', 'retro')
           returning id`,
        );
        retiredLaneSessionId = retired.rows[0].id as string;
        await pool.query(
          `insert into cover_art_studio_batches
             (id, owner_user_id, client_request_id, effective_music_prompt, session_name,
              style_snapshot, provider_key, model, requested_styles, state, candidate_count)
           values ($1, 'owner-1', $2, 'retired lanes studio prompt', 'One Quiet Orbit',
              '{}', 'test-provider', 'test-model', '["abstract", "minimal", "surreal"]', 'complete', 1)`,
          [retiredLaneBatchId, crypto.randomUUID()],
        );
        await pool.query(
          `insert into cover_art_studio_candidates
             (id, owner_user_id, batch_id, requested_style, resolved_style, provider_key,
              model, idempotency_key, storage_key, state)
           values ($1, 'owner-1', $2, 'collage', 'futuristic', 'test-provider',
              'test-model', $3, $4, 'ready')`,
          [
            retiredLaneCandidateId,
            retiredLaneBatchId,
            `studio-${retiredLaneCandidateId}`,
            `covers/studio/${retiredLaneCandidateId}.webp`,
          ],
        );
        // Point the default style at a retired lane so the final `photographic`
        // assertion witnesses this fold (0035 already remapped `cinematic` here).
        await pool.query(
          `update app_settings
           set value = jsonb_set(value, '{defaultStyle}', '"surreal"')
           where key = 'coverArt'`,
        );
      }
      if (tag === '0034_backfill-track-genre-tags') {
        // Studio work recorded while `cinematic` was still selectable: one live
        // draft and one the owner already deleted (its bytes queued back then).
        await pool.query(
          `insert into cover_art_studio_batches
             (id, owner_user_id, client_request_id, effective_music_prompt, session_name,
              style_snapshot, provider_key, model, requested_styles, state, candidate_count)
           values ($1, 'owner-1', $2, 'legacy studio prompt', 'Last Train Through the Storm',
              '{}', 'test-provider', 'test-model', '["cinematic", "poster_art"]', 'complete', 1)`,
          [studioBatchId, crypto.randomUUID()],
        );
        await pool.query(
          `insert into cover_art_studio_candidates
             (id, owner_user_id, batch_id, requested_style, resolved_style, provider_key,
              model, idempotency_key, storage_key, state)
           values ($1, 'owner-1', $2, 'cinematic', 'cinematic', 'test-provider',
              'test-model', $3, $4, 'ready')`,
          [
            studioCandidateId,
            studioBatchId,
            `studio-${studioCandidateId}`,
            `covers/studio/${studioCandidateId}.webp`,
          ],
        );
        await pool.query(
          `insert into cover_art_studio_candidates
             (id, owner_user_id, batch_id, requested_style, resolved_style, provider_key,
              model, idempotency_key, storage_key, state, deleted_at)
           values ($1, 'owner-1', $2, 'poster_art', 'poster_art', 'test-provider',
              'test-model', $3, $4, 'ready', now())`,
          [
            tombstonedStudioCandidateId,
            studioBatchId,
            `studio-${tombstonedStudioCandidateId}`,
            `covers/studio/${tombstonedStudioCandidateId}.webp`,
          ],
        );
      }
      if (tag === '0018_harsh_black_panther') {
        await pool.query(
          `insert into session_cover_generations
             (id, owner_user_id, activity_session_id, state, plan, plan_version, prompt_version,
              plan_hash, prompt_hash, fingerprint, provider_key, model, capability_snapshot,
              selected_references, idempotency_key, retry_policy, cover_image_id, storage_key,
              attempt_count, max_attempts)
           values
             ($1, 'owner-1', $2, 'planned', '{}', 'plan-v1', 'prompt-v1', 'plan-hash',
              'prompt-hash', '{}', 'test-provider', 'test-model', '{}', $3, $4, '{}', $5, $6, 1, 1)`,
          [
            coverLedgerId,
            sessionId,
            JSON.stringify([{ id: legacyReferenceId, role: 'subject' }]),
            `cover-retry-${coverLedgerId}`,
            crypto.randomUUID(),
            `covers/${coverLedgerId}.webp`,
          ],
        );
      }
    }

    seeded = {
      sessionId,
      prePlanRequestId: prePlan.requestId,
      prePlanTrackId: prePlan.trackId,
      postVibeRequestId: postVibe.requestId,
      postVibeTrackId: postVibe.trackId,
      explicitPresetSessionId: explicitPreset.rows[0].id as string,
      coverLedgerId,
      legacyReferenceId,
      cinematicSessionId: cinematicSession.rows[0].id as string,
      studioCandidateId,
      tombstonedStudioCandidateId,
      retiredLaneSessionId,
      retiredLaneCandidateId,
    };
  }, 120_000);

  afterAll(async () => {
    if (!pool) return;
    // Restore the canonical migrated state (with Drizzle bookkeeping) so the
    // suites that follow can `connectTestDb` normally.
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('DROP SCHEMA IF EXISTS drizzle CASCADE');
    await pool.query('CREATE SCHEMA public');
    await runDrizzleMigrations(db);
    await pool.end();
  });

  it('legacy generation requests carry a NULL blend identity (→ plain edge, always)', async () => {
    for (const requestId of [seeded.prePlanRequestId, seeded.postVibeRequestId]) {
      const { rows } = await pool.query(
        'select style_revision, target_bpm, target_key, style_snapshot from generation_requests where id = $1',
        [requestId],
      );
      expect(rows[0]).toEqual({
        style_revision: null,
        target_bpm: null,
        target_key: null,
        style_snapshot: null,
      });
    }
  });

  it('the session gains styleRevision = 1 (its snapshot counts as revision one)', async () => {
    const { rows } = await pool.query(
      'select style_revision from activity_sessions where id = $1',
      [seeded.sessionId],
    );
    expect(rows[0].style_revision).toBe(1);
  });

  it('legacy tracks default to pending analysis provenance and keep their BPM as a double', async () => {
    const { rows } = await pool.query(
      `select bpm_estimate, analysis_status, analysis_version, bpm_source, bpm_confidence,
              lufs_integrated, reroll_pending_at
       from tracks where id = $1`,
      [seeded.prePlanTrackId],
    );
    expect(Number(rows[0].bpm_estimate)).toBe(96); // integer column upgraded in place
    expect(rows[0].analysis_status).toBe('pending');
    expect(rows[0].analysis_version).toBeNull();
    expect(rows[0].bpm_source).toBeNull();
    expect(rows[0].bpm_confidence).toBeNull();
    expect(rows[0].lufs_integrated).toBeNull();
    expect(rows[0].reroll_pending_at).toBeNull();
  });

  it('backfills a missing Track duration from its recorded final audio asset', async () => {
    const { rows } = await pool.query('select duration_seconds from tracks where id = $1', [
      seeded.prePlanTrackId,
    ]);
    expect(rows[0].duration_seconds).toBe(168);
  });

  it('creates the session_loop_leases table empty', async () => {
    const leases = await pool.query('select count(*)::int as n from session_loop_leases');
    expect(leases.rows[0].n).toBe(0);
  });

  it('separates legacy Buffer enabled state from its retained target', async () => {
    const { rows } = await pool.query(
      `select owner_user_id, value
       from user_settings
       where key = 'generation' and owner_user_id like 'buffer-%'
       order by owner_user_id`,
    );
    expect(rows).toEqual([
      {
        owner_user_id: 'buffer-five',
        value: { bufferEnabled: true, bufferAheadTracks: 5, defaultLanguage: 'English' },
      },
      {
        owner_user_id: 'buffer-missing',
        value: { bufferEnabled: true, bufferAheadTracks: 3, defaultLanguage: 'French' },
      },
      {
        owner_user_id: 'buffer-off',
        value: { bufferEnabled: false, bufferAheadTracks: 3, defaultLanguage: 'German' },
      },
      {
        owner_user_id: 'buffer-one',
        value: { bufferEnabled: true, bufferAheadTracks: 1, defaultLanguage: 'auto' },
      },
    ]);
  });

  it('moves the legacy About text unchanged into one owner Person', async () => {
    const { rows } = await pool.query(
      `select role, name, name_match_key, about, sort_order
       from people where owner_user_id = 'owner-1'`,
    );
    expect(rows).toEqual([
      {
        role: 'owner',
        name: 'Owner',
        name_match_key: 'owner',
        about: '  Weekend trail runs with Tina.  ',
        sort_order: 0,
      },
    ]);
    const aboutColumn = await pool.query(
      `select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'listener_profiles' and column_name = 'about'`,
    );
    expect(aboutColumn.rowCount).toBe(0);
  });

  it('queues legacy reference bytes, removes the legacy table, and preserves frozen ledgers', async () => {
    const legacyTable = await pool.query(
      `select 1 from information_schema.tables
       where table_schema = 'public' and table_name = 'profile_cover_references'`,
    );
    expect(legacyTable.rowCount).toBe(0);
    const queued = await pool.query(
      `select storage_key, reason from deletion_queue_items
       where owner_user_id = 'owner-1' and storage_key = $1`,
      [`profile-references/owner-1/${seeded.legacyReferenceId}.webp`],
    );
    expect(queued.rows).toEqual([
      {
        storage_key: `profile-references/owner-1/${seeded.legacyReferenceId}.webp`,
        reason: 'legacy_profile_reference_migration',
      },
    ]);
    const ledger = await pool.query(
      'select selected_references from session_cover_generations where id = $1',
      [seeded.coverLedgerId],
    );
    expect(ledger.rows[0].selected_references).toEqual([
      { id: seeded.legacyReferenceId, role: 'subject' },
    ]);
  });

  it('migrates legacy Auto-plus-hint to authoritative Custom and clears preset hints', async () => {
    const custom = await pool.query(
      `select cover_style, cover_style_hint, cover_style_hint_normalized
       from activity_sessions where id = $1`,
      [seeded.sessionId],
    );
    expect(custom.rows[0]).toEqual({
      cover_style: 'custom',
      cover_style_hint: 'torn paper collage',
      cover_style_hint_normalized: 'torn paper collage',
    });
    const preset = await pool.query(
      `select cover_style, cover_style_hint, cover_style_hint_normalized
       from activity_sessions where id = $1`,
      [seeded.explicitPresetSessionId],
    );
    expect(preset.rows[0]).toEqual({
      cover_style: 'photographic',
      cover_style_hint: null,
      cover_style_hint_normalized: null,
    });
  });

  it('folds the retired cinematic cover style into photographic everywhere it was persisted', async () => {
    const session = await pool.query(`select cover_style from activity_sessions where id = $1`, [
      seeded.cinematicSessionId,
    ]);
    expect(session.rows[0]).toEqual({ cover_style: 'photographic' });

    const settings = await pool.query(
      `select value ->> 'defaultStyle' as default_style from app_settings where key = 'coverArt'`,
    );
    expect(settings.rows[0]).toEqual({ default_style: 'photographic' });

    const enumValues = await pool.query(
      `select enumlabel from pg_enum
       join pg_type on pg_type.oid = pg_enum.enumtypid
       where typname = 'cover_style'
       order by enumsortorder`,
    );
    expect(enumValues.rows.map((row) => row.enumlabel as string)).not.toContain('cinematic');
  });

  it('folds every retired lane into its nearest kept lane', async () => {
    const session = await pool.query(`select cover_style from activity_sessions where id = $1`, [
      seeded.retiredLaneSessionId,
    ]);
    expect(session.rows[0]).toEqual({ cover_style: 'photographic' });

    const settings = await pool.query(
      `select value ->> 'defaultStyle' as default_style from app_settings where key = 'coverArt'`,
    );
    expect(settings.rows[0]).toEqual({ default_style: 'photographic' });

    const enumValues = await pool.query(
      `select enumlabel from pg_enum
       join pg_type on pg_type.oid = pg_enum.enumtypid
       where typname = 'cover_style'
       order by enumsortorder`,
    );
    // The upgraded enum must land in the shared contract's order — the 0055
    // recreate mirrors `COVER_STYLES`.
    expect(enumValues.rows.map((row) => row.enumlabel as string)).toEqual([...COVER_STYLES]);
  });

  it('queues live Studio draft bytes and drops the Studio tables and types', async () => {
    // The tombstoned draft's key was queued when it was deleted, so the drop
    // does not queue it again.
    const queued = await pool.query(
      `select storage_key, reason from deletion_queue_items
       where owner_user_id = 'owner-1' and storage_key like 'covers/studio/%'`,
    );
    expect(queued.rows).toHaveLength(2);
    expect(queued.rows).toEqual(
      expect.arrayContaining(
        [seeded.studioCandidateId, seeded.retiredLaneCandidateId].map((id) => ({
          storage_key: `covers/studio/${id}.webp`,
          reason: 'cover_art_studio_removed',
        })),
      ),
    );

    const tables = await pool.query(
      `select table_name from information_schema.tables
       where table_schema = 'public' and table_name like 'cover_art_studio_%'`,
    );
    expect(tables.rowCount).toBe(0);
    const types = await pool.query(
      `select typname from pg_type where typname like 'cover_art_studio_%'`,
    );
    expect(types.rowCount).toBe(0);
  });

  it('renames the persisted cover retry budget without losing its count', async () => {
    const { rows } = await pool.query(
      `select safe_retry_count, max_safe_retries
       from session_cover_generations where id = $1`,
      [seeded.coverLedgerId],
    );
    expect(rows[0]).toEqual({ safe_retry_count: 1, max_safe_retries: 1 });
  });
});
