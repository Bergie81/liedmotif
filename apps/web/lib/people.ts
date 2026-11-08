import type { PersonReferencePhotoRow, PersonRow } from '@liedmotif/db';
import { toPersonReferencePhotoSummary } from './person-reference-photos';
import type { PersonReferencePhotoSummary } from './person-reference-photos';

export interface PersonSummary {
  id: string;
  role: 'owner' | 'ordinary';
  name: string;
  about: string;
}

/** Keep ownership keys and canonical matching keys out of Settings responses. */
export function toPersonSummary(person: PersonRow): PersonSummary {
  return {
    id: person.id,
    role: person.role as PersonSummary['role'],
    name: person.name,
    about: person.about,
  };
}

/** The roster shape the People editor renders: each Person with its own photos. */
export function toPersonRoster(
  people: readonly PersonRow[],
  photos: readonly PersonReferencePhotoRow[],
): Array<PersonSummary & { photos: PersonReferencePhotoSummary[] }> {
  return people.map((person) => ({
    ...toPersonSummary(person),
    photos: photos
      .filter((photo) => photo.personId === person.id)
      .map(toPersonReferencePhotoSummary),
  }));
}
