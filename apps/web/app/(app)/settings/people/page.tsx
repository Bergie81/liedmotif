import {
  ensureOwnerPerson,
  getCoverReferenceFrequency,
  listPeople,
  listPersonReferencePhotos,
  MAX_OWNER_PERSON_REFERENCE_PHOTOS,
  MAX_PEOPLE_PER_OWNER,
  MAX_PERSON_ABOUT_LENGTH,
  MAX_PERSON_NAME_LENGTH,
  MAX_PERSON_REFERENCE_PHOTOS,
} from '@liedmotif/db';
import { PeopleForm } from '@/components/settings/people-form';
import { SettingsColumns, SettingsPageHeader } from '@/components/settings/settings-ui';
import { getDb } from '@/lib/db';
import { toPersonRoster } from '@/lib/people';
import { requireAppAccess } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function PeopleSettingsPage() {
  const { session } = await requireAppAccess();
  const db = getDb();
  await ensureOwnerPerson(db, session.user.id);
  const [people, photos, frequency] = await Promise.all([
    listPeople(db, session.user.id),
    listPersonReferencePhotos(db, { ownerUserId: session.user.id }),
    getCoverReferenceFrequency(db, session.user.id),
  ]);

  return (
    <section>
      <SettingsPageHeader
        title="People"
        description="Add People who can appear in generated covers and inspire personalized lyrics."
      />
      <SettingsColumns>
        <PeopleForm
          initialPeople={toPersonRoster(people, photos)}
          initialFrequency={frequency}
          ownerImageUrl={session.user.image ?? null}
          maxPeople={MAX_PEOPLE_PER_OWNER}
          maxNameLength={MAX_PERSON_NAME_LENGTH}
          maxAboutLength={MAX_PERSON_ABOUT_LENGTH}
          maxPhotosPerPerson={MAX_PERSON_REFERENCE_PHOTOS}
          maxPhotosTotal={MAX_OWNER_PERSON_REFERENCE_PHOTOS}
        />
      </SettingsColumns>
    </section>
  );
}
