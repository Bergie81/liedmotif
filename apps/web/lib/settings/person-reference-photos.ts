import type { PersonReferencePhotoRow } from '@liedmotif/db';

export interface PersonReferencePhotoSummary {
  id: string;
  personId: string;
  mediaType: string;
  width: number | null;
  height: number | null;
  imageUrl: string;
  createdAt: string;
}

export function toPersonReferencePhotoSummary(
  photo: PersonReferencePhotoRow,
): PersonReferencePhotoSummary {
  return {
    id: photo.id,
    personId: photo.personId,
    mediaType: photo.mediaType,
    width: photo.width,
    height: photo.height,
    imageUrl: `/api/settings/people/${photo.personId}/photos/${photo.id}/image`,
    createdAt: photo.createdAt.toISOString(),
  };
}
