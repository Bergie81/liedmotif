import type { PersonSummary } from '@/lib/people';

/** A roster entry as the fallback rules read it: whose card, and whether it has photos. */
type PhotographedPerson = Pick<PersonSummary, 'role'> & { photos: readonly unknown[] };

export interface PersonFieldErrors {
  name?: string;
  about?: string;
}

/** How many People are actually named, for surfaces that summarize the roster. */
export function namedPeopleCount(people: readonly Pick<PersonSummary, 'name'>[]): number {
  return people.filter((person) => person.name.trim()).length;
}

/**
 * Whether the no-name Cover fallback has anything to work with. It puts the OWNER on
 * a Cover, so it needs a likeness of them specifically — another Person's photo
 * cannot stand in, and a roster that has not loaded yet has none.
 */
export function ownerCoverFallbackReady(people: readonly PhotographedPerson[]): boolean {
  const owner = people.find((person) => person.role === 'owner');
  return (owner?.photos.length ?? 0) > 0;
}

/**
 * Take the server's names and About text onto a local roster, matched by id, while
 * keeping each Person's locally-held photos. The server's summaries carry no photos,
 * so replacing the roster outright would blank them.
 */
export function mergePersonNames<T extends PersonSummary>(
  roster: readonly T[],
  fromServer: readonly PersonSummary[],
): T[] {
  const byId = new Map(fromServer.map((person) => [person.id, person]));
  return roster.map((person) => {
    const latest = byId.get(person.id);
    return latest ? { ...person, name: latest.name, about: latest.about } : person;
  });
}

export function validatePersonFields({
  name,
  about,
  maxNameLength,
  maxAboutLength,
}: {
  name: string;
  about: string;
  maxNameLength: number;
  maxAboutLength: number;
}): PersonFieldErrors {
  const errors: PersonFieldErrors = {};
  if (!name.trim()) errors.name = 'Enter a Person name.';
  else if (name.trim().length > maxNameLength) {
    errors.name = `Name must be at most ${maxNameLength} characters.`;
  }
  if (about.trim().length > maxAboutLength) {
    errors.about = `About must be at most ${maxAboutLength} characters.`;
  }
  return errors;
}
