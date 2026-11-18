// Everything the first-login onboarding screens read, resolved server-side in one
// place. Credentials arrive as STATUS only (where it came from, masked preview,
// whether it is usable) — no secret ever reaches the wizard, which is a client
// component.
//
// Provider state comes from the same resolver Settings → Providers uses, so the two
// surfaces cannot disagree about what is configured. `environmentManaged` is the one
// fact the steps branch on: an `.env` credential wins, so its step renders read-only
// rather than offering a field that could never take effect.

import {
  EMPTY_LISTENER_PROFILE,
  MAX_OWNER_PERSON_REFERENCE_PHOTOS,
  MAX_PEOPLE_PER_OWNER,
  MAX_PERSON_ABOUT_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  MAX_PERSON_REFERENCE_PHOTOS,
  ensureOwnerPerson,
  getCoverArtSettings,
  getCoverReferenceFrequency,
  getGenerationSettings,
  getListenerProfile,
  getPlaybackSettings,
  getUsageLimits,
  listPeople,
  listPersonReferencePhotos,
  type CoverArtSettings,
  type ListenerProfile,
  type UsageLimits,
} from '@liedmotif/db';
import type { GenerationSettings, PlaybackSettings } from '@liedmotif/shared';
import type { StorageProviderKey } from '@liedmotif/storage';
import { providerDisplayName } from '@/lib/configurable-providers';
import { sunoCoverFallbackConfigured } from '@/lib/covers';
import { getDb } from '@/lib/db';
import { isAccountEmailEnabled } from '@/lib/env';
import { toPersonRoster } from '@/lib/people';
import { loadProviderSettingsData } from '@/lib/provider-settings-data';
import { getStorageProvider, getTypicalTracksPerMusicRequest } from '@/lib/providers';
import { resolveOwnVoiceOffer, type OwnVoiceOffer } from '@/lib/voice';
import type { PeopleFormProps } from '@/components/settings/people-types';

/** A provider step's resolved state: what is set, from where, and what to edit. */
export interface OnboardingCredential {
  providerKey: string;
  displayName: string;
  /** The active value comes from `.env`, which no field here could outrank. */
  environmentManaged: boolean;
  /** A credential is resolvable and usable as configured. */
  configured: boolean;
  masked: string | null;
  baseUrl?: string;
  model?: string;
  /** `model` comes from `.env`, which no field here could outrank. */
  modelEnvironmentManaged?: boolean;
}

/** The Cover image provider's resolved state. */
export interface OnboardingImageCredential extends OnboardingCredential {
  /** The loaded provider uses the Text AI's key now (`masked` is then that key). */
  sharesKey: boolean;
  /** `IMAGE_PROVIDER` picks `providerKey`, which no choice here could outrank. */
  providerEnvironmentManaged?: boolean;
}

/**
 * The settings the closing screen reports as left alone. Facts, not sentences —
 * the step words them, because copy belongs beside the markup that renders it.
 */
export interface OnboardingUntouched {
  playback: PlaybackSettings;
  generation: GenerationSettings;
  coverStyle: CoverArtSettings['defaultStyle'];
  /** `hidden` while the own-voice feature is switched off. */
  ownVoiceOffer: OwnVoiceOffer;
  /** Account email is on; it is set in `.env` only, never from a screen. */
  accountEmail: boolean;
  /** The backend Tracks are written to, chosen in `.env` like the email. */
  storageProvider: StorageProviderKey;
}

export interface OnboardingData {
  profile: ListenerProfile;
  people: PeopleFormProps;
  limits: UsageLimits;
  tracksPerRequest: number;
  encryptionKeyConfigured: boolean;
  music: OnboardingCredential;
  llm: OnboardingCredential;
  /** The optional cover-image provider; `model` is the model its covers render with. */
  image: OnboardingImageCredential & {
    /** A Cover provider is stored or set in `.env`, rather than `providerKey` being the default. */
    chosen: boolean;
    /** The image provider that can use the Text AI's key, or `null`. */
    sharedKeyVendor: string | null;
  };
  /** The music provider can draw its own Covers, so Covers never fall to the placeholder. */
  musicProviderCoverConfigured: boolean;
  untouched: OnboardingUntouched;
}

/** The People form's payload from already-loaded rows — the caps ride along here. */
function peopleFormProps(
  people: Awaited<ReturnType<typeof listPeople>>,
  photos: Awaited<ReturnType<typeof listPersonReferencePhotos>>,
  initialFrequency: PeopleFormProps['initialFrequency'],
): PeopleFormProps {
  return {
    initialPeople: toPersonRoster(people, photos),
    initialFrequency,
    maxPeople: MAX_PEOPLE_PER_OWNER,
    maxNameLength: MAX_PERSON_NAME_LENGTH,
    maxAboutLength: MAX_PERSON_ABOUT_LENGTH,
    maxPhotosPerPerson: MAX_PERSON_REFERENCE_PHOTOS,
    maxPhotosTotal: MAX_OWNER_PERSON_REFERENCE_PHOTOS,
  };
}

/** The People form's full payload for one owner — shared with the Member welcome. */
export async function loadPeopleFormProps(ownerUserId: string): Promise<PeopleFormProps> {
  const db = getDb();
  const [people, photos, initialFrequency] = await Promise.all([
    listPeople(db, ownerUserId),
    listPersonReferencePhotos(db, { ownerUserId }),
    getCoverReferenceFrequency(db, ownerUserId),
  ]);
  return peopleFormProps(people, photos, initialFrequency);
}

function imageCredential(
  cover: Awaited<ReturnType<typeof loadProviderSettingsData>>['cover'],
): OnboardingData['image'] {
  return {
    providerKey: cover.providerKey,
    displayName: providerDisplayName('image', cover.providerKey),
    environmentManaged: cover.credential?.source === 'env',
    configured: cover.configured,
    masked: cover.credential?.masked ?? null,
    ...(cover.model ? { model: cover.model } : {}),
    modelEnvironmentManaged: cover.modelEnvironmentManaged,
    providerEnvironmentManaged: cover.providerEnvironmentManaged,
    sharesKey: cover.sharesKey,
    chosen: cover.credential !== null,
    sharedKeyVendor: cover.sharedKeyVendor,
  };
}

export async function loadOnboardingData(ownerUserId: string): Promise<OnboardingData> {
  const db = getDb();
  await ensureOwnerPerson(db, ownerUserId);
  const [
    profile,
    people,
    photos,
    coverReferenceFrequency,
    limits,
    providers,
    playback,
    generation,
    coverArt,
    ownVoiceOffer,
  ] = await Promise.all([
    getListenerProfile(db, ownerUserId),
    listPeople(db, ownerUserId),
    listPersonReferencePhotos(db, { ownerUserId }),
    getCoverReferenceFrequency(db, ownerUserId),
    getUsageLimits(db),
    loadProviderSettingsData(),
    getPlaybackSettings(db, ownerUserId),
    getGenerationSettings(db, ownerUserId),
    getCoverArtSettings(db, ownerUserId),
    // Admin-only flow (`loadMemberOnboardingData` serves Members), so the
    // admin role is a fact of the caller, not a lookup.
    resolveOwnVoiceOffer(db, { userId: ownerUserId, role: 'admin' }).catch(
      (): OwnVoiceOffer => 'setup',
    ),
  ]);

  return {
    profile: profile ?? EMPTY_LISTENER_PROFILE,
    people: peopleFormProps(people, photos, coverReferenceFrequency),
    limits,
    tracksPerRequest: getTypicalTracksPerMusicRequest(),
    encryptionKeyConfigured: providers.encryptionKeyConfigured,
    music: {
      providerKey: providers.music.credential.providerKey,
      displayName: providers.music.credential.displayName || 'Suno-compatible',
      environmentManaged: providers.music.source === 'Environment',
      configured: providers.music.credential.configured,
      masked: providers.music.credential.masked,
      baseUrl: providers.music.baseUrl,
    },
    llm: {
      providerKey: providers.llm.providerKey,
      displayName: providers.llm.credential?.displayName || providers.llm.providerKey,
      environmentManaged: providers.llm.presentation.source === 'Environment',
      // The presentation's own health check, so "Connected" here can never mean
      // something Settings would call Unhealthy.
      configured: providers.llm.presentation.configured,
      masked: providers.llm.credential?.masked ?? null,
      baseUrl: providers.llm.settings?.baseUrl,
      model: providers.llm.effectiveModel ?? undefined,
    },
    image: imageCredential(providers.cover),
    musicProviderCoverConfigured: await sunoCoverFallbackConfigured(),
    untouched: {
      playback,
      generation,
      coverStyle: coverArt.defaultStyle,
      ownVoiceOffer,
      accountEmail: isAccountEmailEnabled(),
      storageProvider: getStorageProvider().providerKey,
    },
  };
}
