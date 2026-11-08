import { createHash } from 'node:crypto';
import { matchConfiguredPeople } from '@liedmotif/shared';
import type { CoverReferenceRefusal } from '../schema';
import type { CoverReferenceFrequency } from './people-settings-repo';

export interface CoverReferenceEndpointCapabilities {
  references: {
    roles: readonly string[];
    maxCount: number;
    mediaTypes: readonly string[];
    maxBytesPerReference?: number;
    maxTotalBytes?: number;
  } | null;
}

export interface CoverSelectablePerson {
  id: string;
  role: string;
  name: string;
  nameMatchKey?: string;
  sortOrder: number;
}

export interface CoverSelectablePhoto {
  id: string;
  personId: string;
  mediaType: string;
  byteSize: number;
}

export interface SelectedPersonCoverReference {
  id: string;
  personId: string;
  role: 'subject';
}

export interface PersonCoverReferenceSelection {
  selectedPersonId: string | null;
  selectedPersonIds: string[];
  selectedPersonNames: string[];
  selectedReferences: SelectedPersonCoverReference[];
  terminalReason: CoverReferenceRefusal | null;
}

function fallbackFrequencyAllowsReference(
  frequency: CoverReferenceFrequency,
  ownerUserId: string,
  contextId: string,
): boolean {
  if (frequency === 'never') return false;
  if (frequency === 'always') return true;
  const roll =
    Number.parseInt(
      createHash('sha256')
        .update(`${ownerUserId}:${contextId}:reference`)
        .digest('hex')
        .slice(0, 8),
      16,
    ) / 0xffffffff;
  return roll < (frequency === 'regularly' ? 0.55 : 0.2);
}

function rankedPhotos(
  contextId: string,
  personId: string,
  photos: readonly CoverSelectablePhoto[],
): CoverSelectablePhoto[] {
  return [...photos].sort((left, right) => {
    const score = (photo: CoverSelectablePhoto) =>
      createHash('sha256').update(`${contextId}:${personId}:${photo.id}`).digest('hex');
    return score(left).localeCompare(score(right));
  });
}

function endpointSubset(
  contextId: string,
  personId: string,
  photos: readonly CoverSelectablePhoto[],
  capabilities: CoverReferenceEndpointCapabilities,
): CoverSelectablePhoto[] | null {
  const limits = capabilities.references;
  if (!limits || !limits.roles.includes('subject') || limits.maxCount < 1) return null;
  const compatible = photos.filter(
    (photo) =>
      limits.mediaTypes.includes(photo.mediaType) &&
      (limits.maxBytesPerReference === undefined || photo.byteSize <= limits.maxBytesPerReference),
  );
  if (compatible.length === 0) return null;
  const total = compatible.reduce((sum, photo) => sum + photo.byteSize, 0);
  if (
    compatible.length <= limits.maxCount &&
    (limits.maxTotalBytes === undefined || total <= limits.maxTotalBytes)
  ) {
    return compatible;
  }

  const selected: CoverSelectablePhoto[] = [];
  let selectedBytes = 0;
  for (const photo of rankedPhotos(contextId, personId, compatible)) {
    if (selected.length >= limits.maxCount) break;
    if (
      limits.maxTotalBytes !== undefined &&
      selectedBytes + photo.byteSize > limits.maxTotalBytes
    ) {
      continue;
    }
    selected.push(photo);
    selectedBytes += photo.byteSize;
  }
  return selected.length > 0 ? selected : null;
}

function multiPersonReferences(
  contextId: string,
  people: readonly CoverSelectablePerson[],
  photos: readonly CoverSelectablePhoto[],
  capabilities: CoverReferenceEndpointCapabilities,
): Pick<PersonCoverReferenceSelection, 'selectedReferences' | 'terminalReason'> {
  const groups = people
    .map((person) => ({
      person,
      photos: rankedPhotos(
        contextId,
        person.id,
        photos.filter((photo) => photo.personId === person.id),
      ),
    }))
    .filter((group) => group.photos.length > 0);
  if (groups.length === 0) return { selectedReferences: [], terminalReason: null };

  const frozenFallback = groups.map(({ person, photos: candidates }) => ({
    id: candidates[0]!.id,
    personId: person.id,
    role: 'subject' as const,
  }));
  const limits = capabilities.references;
  if (!limits || !limits.roles.includes('subject') || limits.maxCount < groups.length) {
    return { selectedReferences: frozenFallback, terminalReason: 'references_unsupported' };
  }
  const compatibleGroups = groups.map(({ person, photos: candidates }) => ({
    person,
    photos: candidates.filter(
      (photo) =>
        limits.mediaTypes.includes(photo.mediaType) &&
        (limits.maxBytesPerReference === undefined ||
          photo.byteSize <= limits.maxBytesPerReference),
    ),
  }));
  if (compatibleGroups.some((group) => group.photos.length === 0)) {
    return { selectedReferences: frozenFallback, terminalReason: 'references_unsupported' };
  }
  const maxTotalBytes = limits.maxTotalBytes;

  function choose(
    index: number,
    chosen: CoverSelectablePhoto[],
    totalBytes: number,
  ): CoverSelectablePhoto[] | null {
    if (index === compatibleGroups.length) return chosen;
    for (const photo of compatibleGroups[index]!.photos) {
      const nextBytes = totalBytes + photo.byteSize;
      if (maxTotalBytes !== undefined && nextBytes > maxTotalBytes) continue;
      const complete = choose(index + 1, [...chosen, photo], nextBytes);
      if (complete) return complete;
    }
    return null;
  }

  const selected = choose(0, [], 0);
  if (!selected) {
    return { selectedReferences: frozenFallback, terminalReason: 'references_unsupported' };
  }
  return {
    selectedReferences: selected.map((photo, index) => ({
      id: photo.id,
      personId: compatibleGroups[index]!.person.id,
      role: 'subject',
    })),
    terminalReason: null,
  };
}

export interface SelectPersonCoverReferencesInput {
  frequency: CoverReferenceFrequency;
  ownerUserId: string;
  contextId: string;
  promptText: string;
  people: readonly CoverSelectablePerson[];
  photos: readonly CoverSelectablePhoto[];
  capabilities: CoverReferenceEndpointCapabilities;
  /**
   * The user asked for reference photos on THIS attempt: the owner fallback
   * applies without the frequency roll, and any outcome that would send no
   * reference refuses instead of degrading to a prompt-only cover.
   */
  explicitOptIn?: boolean;
}

export function selectPersonCoverReferences(
  args: SelectPersonCoverReferencesInput,
): PersonCoverReferenceSelection {
  // `never` is the hard privacy opt-out and outranks everything, an explicit
  // request included — which it refuses rather than quietly ignores.
  if (args.frequency === 'never') {
    return {
      selectedPersonId: null,
      selectedPersonIds: [],
      selectedPersonNames: [],
      selectedReferences: [],
      terminalReason: args.explicitOptIn ? 'privacy_rejected' : null,
    };
  }
  const selection = matchedOrOwnerReferences(args);
  return args.explicitOptIn && selection.selectedReferences.length === 0
    ? { ...selection, terminalReason: 'references_unsupported' }
    : selection;
}

/** The owner Person, when an explicit request or the frequency roll admits the no-name fallback. */
function ownerFallbackPeople(args: SelectPersonCoverReferencesInput): CoverSelectablePerson[] {
  const admitted =
    args.explicitOptIn ||
    fallbackFrequencyAllowsReference(args.frequency, args.ownerUserId, args.contextId);
  return admitted ? args.people.filter((person) => person.role === 'owner') : [];
}

/** References for the People named in the context, or the owner as the fallback. */
function matchedOrOwnerReferences(
  args: SelectPersonCoverReferencesInput,
): PersonCoverReferenceSelection {
  const mentioned = matchConfiguredPeople(args.promptText, args.people);
  const selectedPeople = mentioned.length > 0 ? mentioned : ownerFallbackPeople(args);
  const selectedPersonIds = selectedPeople.map((person) => person.id);
  const selectedPersonNames = selectedPeople.map((person) => person.name);
  if (selectedPeople.length === 0) {
    return {
      selectedPersonId: null,
      selectedPersonIds,
      selectedPersonNames,
      selectedReferences: [],
      terminalReason: null,
    };
  }
  if (mentioned.length > 1) {
    return {
      selectedPersonId: selectedPeople[0]!.id,
      selectedPersonIds,
      selectedPersonNames,
      ...multiPersonReferences(args.contextId, selectedPeople, args.photos, args.capabilities),
    };
  }
  const selectedPerson = selectedPeople[0]!;
  const available = args.photos.filter((photo) => photo.personId === selectedPerson.id);
  if (available.length === 0) {
    return {
      selectedPersonId: selectedPerson.id,
      selectedPersonIds,
      selectedPersonNames,
      selectedReferences: [],
      terminalReason: null,
    };
  }
  const subset = endpointSubset(args.contextId, selectedPerson.id, available, args.capabilities);
  return {
    selectedPersonId: selectedPerson.id,
    selectedPersonIds,
    selectedPersonNames,
    selectedReferences: (subset ?? available).map((photo) => ({
      id: photo.id,
      personId: selectedPerson.id,
      role: 'subject',
    })),
    terminalReason: subset ? null : 'references_unsupported',
  };
}
