import type { CoverReferenceFrequency } from '@liedmotif/db';
import type { PersonSummary } from '@/lib/people';
import type { PersonReferencePhotoSummary } from '@/lib/person-reference-photos';

export interface PersonEditorValue extends PersonSummary {
  photos: PersonReferencePhotoSummary[];
}

export interface PeopleLimits {
  maxPeople: number;
  maxNameLength: number;
  maxAboutLength: number;
  maxPhotosPerPerson: number;
  maxPhotosTotal: number;
}

export interface PeopleFormProps extends PeopleLimits {
  initialPeople: PersonEditorValue[];
  initialFrequency: CoverReferenceFrequency;
  /** The owner's profile photo, shown on their card in place of an initial. */
  ownerImageUrl?: string | null;
  /**
   * Mirrors the roster out as it changes, for a surface that unmounts this form and
   * has to re-seed it later (the onboarding wizard). Without it, remounting would
   * re-read a stale `initialPeople` and lose a Person added a moment ago.
   */
  onRosterChange?: (people: PersonEditorValue[]) => void;
}

type PeopleErrorBody = { error?: string | { message?: string } } | null;

export function peopleErrorMessage(body: PeopleErrorBody, fallback: string): string {
  if (typeof body?.error === 'string') return body.error;
  return body?.error?.message ?? fallback;
}

export async function peopleResponseMessage(
  response: Response | null,
  fallback: string,
): Promise<string> {
  const body = response ? ((await response.json().catch(() => null)) as PeopleErrorBody) : null;
  return peopleErrorMessage(body, fallback);
}
