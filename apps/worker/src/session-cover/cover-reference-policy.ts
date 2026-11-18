import {
  getCoverReferenceFrequency,
  listPeople,
  listPersonReferencePhotos,
  selectPersonCoverReferences,
  type CoverReferenceOwner,
  type CoverReferenceRefusal,
  type DbOrTx,
  type PersonReferencePhotoRow,
  type SessionCoverSelectedReference,
} from '@liedmotif/db';
import {
  COVER_IMAGE_MEDIA_TYPES,
  type CoverImageMediaType,
  type GeneratedImageCapabilities,
  type GeneratedImageReference,
} from '@liedmotif/providers';
import { matchConfiguredPeople } from '@liedmotif/shared';
import { readAllBytes, type StorageProvider } from '@liedmotif/storage';

export type SelectedCoverReference = Required<
  Pick<SessionCoverSelectedReference, 'id' | 'personId' | 'role'>
>;

export interface CoverReferencePlanSelection {
  selectedPersonId: string | null;
  selectedPersonIds: string[];
  selectedPersonNames: string[];
  selectedReferences: SelectedCoverReference[];
  /** The selected owner Person, when the Session's request includes the listener. */
  listenerPersonId: string | null;
  capabilityDowngrades: string[];
  /** Only an explicit reference request can be refused for privacy at plan
   *  time; a frequency-driven selection degrades to a prompt-only cover. */
  terminalReason: CoverReferenceRefusal | null;
}

export type PreparedCoverReferences =
  | { ok: true; references: GeneratedImageReference[]; referencesOmitted: false }
  | { ok: false; reason: CoverReferenceRefusal };

export interface CoverReferenceSubject {
  personId: string;
  name: string;
  /** This subject is the listener the request puts in its scene. */
  isListener: boolean;
}

export function referenceSubjectsForSelection(
  selection: Pick<
    CoverReferencePlanSelection,
    'selectedPersonIds' | 'selectedPersonNames' | 'selectedReferences' | 'listenerPersonId'
  >,
): CoverReferenceSubject[] {
  const referenceBearing = new Set(
    selection.selectedReferences.flatMap((reference) =>
      reference.personId ? [reference.personId] : [],
    ),
  );
  return selection.selectedPersonIds.flatMap((personId, index) => {
    const name = selection.selectedPersonNames[index];
    return referenceBearing.has(personId) && name
      ? [{ personId, name, isListener: personId === selection.listenerPersonId }]
      : [];
  });
}

type CoverReferencePreflight =
  | { ok: true; photos: Array<PersonReferencePhotoRow & { mediaType: CoverImageMediaType }> }
  | { ok: false; reason: CoverReferenceRefusal };

export function coverReferenceTreatment(
  selectedReferences: readonly SelectedCoverReference[],
): string | null {
  return selectedReferences.length
    ? 'use the selected subject references for identity only; the style plan controls medium, composition, palette, and light'
    : null;
}

export const selectPersonReferences = selectPersonCoverReferences;

export const EMPTY_COVER_REFERENCE_SELECTION: CoverReferencePlanSelection = {
  selectedPersonId: null,
  selectedPersonIds: [],
  selectedPersonNames: [],
  selectedReferences: [],
  listenerPersonId: null,
  capabilityDowngrades: [],
  terminalReason: null,
};

export async function selectCoverReferencesForPlan(
  db: DbOrTx,
  args: {
    ownerUserId: string;
    contextId: string;
    promptText: string;
    capabilities: GeneratedImageCapabilities;
    /** A skip-profile session runs without the owner's own details: the owner
     *  Person is never selected, while other People the request names are. */
    skipProfile?: boolean;
    /** The Session's request includes the listener: the owner Person is named
     *  beside the People matched by name. */
    includesListener?: boolean;
    /** The owner asked this attempt for reference photos (see
     *  `selectPersonCoverReferences` for what the mode changes). */
    explicitOptIn?: boolean;
    /** The raw art direction of a user regeneration. When it names at least
     *  one configured Person, those People alone decide the attempt's photos:
     *  `promptText` and `includesListener` are set aside, while `skipProfile`
     *  still keeps the owner out. */
    coverWish?: string;
  },
): Promise<CoverReferencePlanSelection> {
  // A music-task-driven provider consumes no prompt and no references — the
  // person policy cannot apply, and (unlike a styled attempt, where a missing
  // required person is worse than no generated cover) it must never refuse the
  // attempt.
  if (args.capabilities.musicTaskSource) return EMPTY_COVER_REFERENCE_SELECTION;
  const frequency = await getCoverReferenceFrequency(db, args.ownerUserId);
  if (frequency === 'never') {
    // The `never` answer, reached without loading a single Person row — what
    // makes the opt-out a guarantee about photo reads and not just outcomes.
    return {
      ...EMPTY_COVER_REFERENCE_SELECTION,
      terminalReason: args.explicitOptIn ? 'privacy_rejected' : null,
    };
  }
  const [people, photos] = await Promise.all([
    listPeople(db, args.ownerUserId),
    listPersonReferencePhotos(db, { ownerUserId: args.ownerUserId }),
  ]);
  const namingWish =
    args.coverWish && matchConfiguredPeople(args.coverWish, people).length > 0
      ? args.coverWish
      : null;
  return {
    ...selectPersonCoverReferences({
      frequency,
      people,
      photos,
      ownerUserId: args.ownerUserId,
      contextId: args.contextId,
      promptText: namingWish ?? args.promptText,
      capabilities: args.capabilities,
      explicitOptIn: args.explicitOptIn,
      owner: coverReferenceOwner({
        skipProfile: args.skipProfile,
        includesListener: namingWish === null && args.includesListener,
      }),
    }),
    capabilityDowngrades: [],
  };
}

function coverReferenceOwner(args: {
  skipProfile?: boolean;
  includesListener?: boolean;
}): CoverReferenceOwner {
  if (args.skipProfile) return 'exclude';
  if (args.includesListener) return 'include';
  return 'fallback';
}

const COVER_IMAGE_MEDIA_TYPE_VALUES: readonly string[] = COVER_IMAGE_MEDIA_TYPES;

function isCoverImageMediaType(value: string): value is CoverImageMediaType {
  return COVER_IMAGE_MEDIA_TYPE_VALUES.includes(value);
}

export async function prepareCoverReferencesForSubmission(
  db: DbOrTx,
  args: {
    ownerUserId: string;
    selectedReferences: readonly SessionCoverSelectedReference[];
    capabilities: GeneratedImageCapabilities;
    storage: StorageProvider;
  },
): Promise<PreparedCoverReferences> {
  const preflight = await preflightCoverReferencesForSubmission(db, args);
  if (!preflight.ok) return preflight;
  const references: GeneratedImageReference[] = [];
  let totalBytes = 0;
  for (const [index, row] of preflight.photos.entries()) {
    const selected = args.selectedReferences[index]!;
    try {
      const bytes = await readAllBytes(await args.storage.readStream(row.storageKey));
      totalBytes += bytes.byteLength;
      if (
        (args.capabilities.references?.maxBytesPerReference !== undefined &&
          bytes.byteLength > args.capabilities.references.maxBytesPerReference) ||
        (args.capabilities.references?.maxTotalBytes !== undefined &&
          totalBytes > args.capabilities.references.maxTotalBytes)
      ) {
        return { ok: false, reason: 'references_unsupported' };
      }
      references.push({ id: row.id, role: selected.role, mediaType: row.mediaType, bytes });
    } catch {
      return { ok: false, reason: 'privacy_rejected' };
    }
  }
  return { ok: true, references, referencesOmitted: false };
}

async function preflightCoverReferencesForSubmission(
  db: DbOrTx,
  args: {
    ownerUserId: string;
    selectedReferences: readonly SessionCoverSelectedReference[];
    capabilities: GeneratedImageCapabilities;
  },
): Promise<CoverReferencePreflight> {
  if (args.selectedReferences.length === 0) {
    return { ok: true, photos: [] };
  }
  if ((await getCoverReferenceFrequency(db, args.ownerUserId)) === 'never') {
    return { ok: false, reason: 'privacy_rejected' };
  }
  const limits = args.capabilities.references;
  if (
    !limits ||
    args.selectedReferences.length > limits.maxCount ||
    !limits.roles.includes('subject')
  ) {
    return { ok: false, reason: 'references_unsupported' };
  }

  const rows = await listPersonReferencePhotos(db, { ownerUserId: args.ownerUserId });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const selectedPhotos: Array<PersonReferencePhotoRow & { mediaType: CoverImageMediaType }> = [];
  let totalBytes = 0;
  for (const selected of args.selectedReferences) {
    const row = byId.get(selected.id);
    if (!row || !selected.personId || row.personId !== selected.personId) {
      return { ok: false, reason: 'privacy_rejected' };
    }
    if (
      !isCoverImageMediaType(row.mediaType) ||
      !limits.roles.includes(selected.role) ||
      !limits.mediaTypes.includes(row.mediaType) ||
      (limits.maxBytesPerReference !== undefined && row.byteSize > limits.maxBytesPerReference) ||
      (limits.maxTotalBytes !== undefined && totalBytes + row.byteSize > limits.maxTotalBytes)
    ) {
      return { ok: false, reason: 'references_unsupported' };
    }
    selectedPhotos.push({ ...row, mediaType: row.mediaType });
    totalBytes += row.byteSize;
  }
  return { ok: true, photos: selectedPhotos };
}

export function promptForCoverReferenceSubmission(
  prompt: string,
  referencesOmitted: boolean,
): string {
  return referencesOmitted
    ? prompt
        .split('\n')
        .filter((line) => !line.startsWith('Reference treatment:'))
        .join('\n')
    : prompt;
}

export function mergeCapabilityDowngrades(...groups: ReadonlyArray<readonly string[]>): string[] {
  return [...new Set(groups.flat())];
}
