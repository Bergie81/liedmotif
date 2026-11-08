export {
  countPeople,
  createPerson,
  deletePerson,
  ensureOwnerPerson,
  listPeople,
  updatePerson,
  MAX_PEOPLE_PER_OWNER,
  MAX_PERSON_ABOUT_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  PersonLimitError,
  PersonNameConflictError,
  PersonValidationError,
  type PersonRow,
} from './people-repo';

export {
  COVER_REFERENCE_FREQUENCIES,
  getCoverReferenceFrequency,
  updateCoverReferenceFrequency,
  type CoverReferenceFrequency,
} from './people-settings-repo';
export {
  selectPersonCoverReferences,
  type CoverReferenceEndpointCapabilities,
  type CoverSelectablePerson,
  type CoverSelectablePhoto,
  type PersonCoverReferenceSelection,
  type SelectedPersonCoverReference,
} from './cover-reference-selection';

export {
  acquireOwnerPersonPhotoLock,
  coverReferencesAvailable,
  deletePersonReferencePhoto,
  getPersonReferencePhoto,
  insertPersonReferencePhoto,
  listPersonReferencePhotos,
  MAX_OWNER_PERSON_REFERENCE_PHOTOS,
  MAX_PERSON_REFERENCE_PHOTOS,
  PERSON_REFERENCE_PHOTO_DELETED_REASON,
  type InsertPersonReferencePhotoInput,
  type InsertPersonReferencePhotoResult,
  type PersonReferencePhotoRow,
} from './person-reference-photos-repo';
