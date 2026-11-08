// Cover helpers for the web process (server-only). A fresh Session always
// starts on the built-in branded placeholder cover; the async generated cover
// (image model, else the music provider's own art) replaces it when it lands,
// and when no generated cover ever arrives the placeholder simply stays.

import {
  getCoverArtSettings,
  PLACEHOLDER_COVER_ID,
  resolveImageRuntimeConfig,
  resolveProviderCredential,
  resolveProviderSettings,
  seedPlaceholderCover,
  type Database,
} from '@liedmotif/db';
import { buildGeneratedImageProvider, OPENROUTER_DEFAULT_COVER_MODEL } from '@liedmotif/providers';
import { COVER_STYLE_PRESETS, type CoverStyle, type CoverStyleChoice } from '@liedmotif/shared';
import { encryptionKeyIfConfigured } from '@/lib/credentials';
import { getDb } from '@/lib/db';
import { getMusicProvider } from '@/lib/providers';
import { enqueueEnsureSessionBuffer, enqueueGenerateSessionCover } from '@/lib/worker-jobs';

/**
 * Whether a usable generated-cover image provider is configured, mirroring the
 * worker's cover-art resolver: the same shared resolution (the env first, then
 * the key saved in onboarding or Settings), built the same way, so it degrades to
 * "no generated covers" without a key. An unknown provider key fails the worker
 * at boot, and an unreadable credential paints nothing either. Only the yes/no
 * leaves this process; the key never reaches the client.
 */
export async function generatedCoverProviderConfigured(
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  try {
    const config = await resolveImageRuntimeConfig(getDb(), {
      env,
      encryptionKey: encryptionKeyIfConfigured(),
    });
    return buildGeneratedImageProvider(config) !== null;
  } catch {
    return false;
  }
}

/**
 * The image model a generated cover will actually be rendered with: `IMAGE_MODEL`,
 * else the model saved with the image key, else the provider default — read per
 * call, as the worker resolves it for each cover. Surfaces that merely NAME the
 * model — such as the LLM's cover-direction context — must read it here rather
 * than assume the default. Never reads the secret.
 */
export async function generatedCoverModel(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const credential = await resolveProviderCredential(getDb(), { providerType: 'image', env });
  const settings = credential
    ? resolveProviderSettings('image', credential.providerKey, credential.config, env)
    : {};
  return settings.model ?? OPENROUTER_DEFAULT_COVER_MODEL;
}

/**
 * Whether the Suno cover-art source is BUILDABLE, mirroring the worker's
 * `getSunoCoverArt`: the real Suno music provider selected and buildable, which
 * it is exactly when it has a key — from `.env` or saved in the app. It needs no
 * owner opt-in — it takes over whenever tailored cover art cannot run. Only the
 * yes/no leaves this process; the key never reaches the client.
 */
export async function sunoCoverFallbackConfigured(): Promise<boolean> {
  if (process.env.MUSIC_PROVIDER?.trim() !== 'suno') return false;
  return getMusicProvider().then(
    () => true,
    () => false,
  );
}

/**
 * The initial Session Cover a create route stores: always the built-in branded
 * placeholder. `activity_sessions.cover_image_id` is a FOREIGN KEY, so the row
 * must exist before creation stores the id — hence the idempotent re-seed, which
 * covers an instance whose DB predates the placeholder. Bytes are not this
 * function's problem; the covers route self-heals those on first serve.
 *
 * Errors degrade to `null` ("no cover") rather than risking an FK violation:
 * cover art must never block Start Session, and the UI renders the placeholder
 * art anyway through its reserved route alias.
 */
export async function initialSessionCoverId(db: Database): Promise<string | null> {
  try {
    await seedPlaceholderCover(db);
    return PLACEHOLDER_COVER_ID;
  } catch {
    return null;
  }
}

/**
 * Both create routes' post-commit kickoffs: the initial Buffer fill (so the
 * first provider submit does not wait for the worker's once-per-minute sweep;
 * same job key, so the sweep's enqueue dedupes and the buffer controller still
 * decides what to spend) and the async generated cover (best-effort — it
 * replaces the placeholder when it lands; on a failed enqueue the placeholder
 * simply stays). Parallel, best-effort — neither throws, so a failed enqueue
 * never fails the creation response.
 */
export async function launchSessionCreationKickoffs(
  db: Database,
  session: { id: string; ownerUserId: string },
): Promise<void> {
  await Promise.all([
    enqueueEnsureSessionBuffer(db, session.id),
    enqueueGenerateSessionCover(db, {
      activitySessionId: session.id,
      ownerUserId: session.ownerUserId,
    }),
  ]);
}

/** The stored cover-art preferences a Start Session request resolves to. */
export interface ResolvedCoverArtChoice {
  coverStyle?: CoverStyle;
  coverStyleHint?: string;
}

/**
 * Resolve the create card's cover-style choice into what the session stores.
 * `random` resolves here, at creation, to a persisted concrete style — a
 * uniform roll over the preset lanes plus Custom when a definition is saved —
 * and an unset Custom definition degrades to Auto, so the persisted state is
 * always authoritative and internally complete.
 */
export async function resolveCoverArtChoice(
  db: Database,
  choice: CoverStyleChoice | undefined,
  random: () => number = Math.random,
): Promise<ResolvedCoverArtChoice> {
  // Only `custom` and `random` can land on the saved Custom definition; every
  // other choice resolves without the settings read.
  const definition =
    choice === 'custom' || choice === 'random'
      ? (await getCoverArtSettings(db)).customStyleDefinition
      : '';
  return resolveCoverArtChoiceFrom(definition, choice, random);
}

/**
 * The pure core of {@link resolveCoverArtChoice}, for callers that already hold
 * the stored cover-art settings — the create routes read them once per request.
 */
export function resolveCoverArtChoiceFrom(
  customStyleDefinition: string,
  choice: CoverStyleChoice | undefined,
  random: () => number = Math.random,
): ResolvedCoverArtChoice {
  if (choice === undefined) return {};
  if (choice !== 'custom' && choice !== 'random') return { coverStyle: choice };
  const definition = customStyleDefinition.trim();
  if (choice === 'random') {
    const pool: readonly CoverStyle[] = definition
      ? [...COVER_STYLE_PRESETS, 'custom']
      : COVER_STYLE_PRESETS;
    const rolled = pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
    if (rolled !== 'custom') return { coverStyle: rolled };
  }
  return definition ? { coverStyle: 'custom', coverStyleHint: definition } : { coverStyle: 'auto' };
}
