'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import type { CoverReferenceFrequency } from '@liedmotif/db';
import type { PersonSummary } from '@/lib/settings/people';
import type { PersonReferencePhotoSummary } from '@/lib/settings/person-reference-photos';
import { cn } from '@/lib/cn';
import { toast } from '@/lib/toast';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { segmentedListClass, segmentedTriggerClass } from '@/components/ui/design-system';
import { PersonEditor } from './person-editor';
import { PersonFields } from './person-fields';
import {
  COVER_FREQUENCY_OPTIONS,
  ownerCoverFallbackReady,
  validatePersonFields,
  type PersonFieldErrors,
} from './people-form-model';
import { SettingsCard, SettingsFootnote, SettingsSection } from './settings-ui';
import { peopleResponseMessage, type PeopleFormProps } from './people-types';
import { useStoredValue } from './use-stored-value';

const CREATE_KEY = 'person-create';
const FREQUENCY_KEY = 'cover-fallback-save';

export function PeopleForm(props: PeopleFormProps) {
  const [people, setPeople] = useState(props.initialPeople);
  const router = useRouter();
  const [frequency, setFrequency] = useStoredValue(props.initialFrequency);
  const [frequencyBusy, setFrequencyBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newAbout, setNewAbout] = useState('');
  const [creationErrors, setCreationErrors] = useState<PersonFieldErrors>({});
  const totalPhotoCount = people.reduce((total, person) => total + person.photos.length, 0);
  // The fallback has nothing to draw until the owner's own card carries a photo, so
  // the frequency stays inert rather than storing a choice that cannot take effect —
  // and reads as the Never it effectively is, without overwriting what is stored.
  const fallbackReady = ownerCoverFallbackReady(people);
  const shownFrequency = fallbackReady ? frequency : 'never';

  const { onRosterChange } = props;
  useEffect(() => {
    onRosterChange?.(people);
  }, [people, onRosterChange]);

  function updatePerson(next: PersonSummary) {
    setPeople((current) =>
      current.map((person) =>
        person.id === next.id ? { ...next, photos: person.photos } : person,
      ),
    );
  }

  function addPhoto(personId: string, photo: PersonReferencePhotoSummary) {
    setPeople((current) =>
      current.map((person) =>
        person.id === personId ? { ...person, photos: [...person.photos, photo] } : person,
      ),
    );
  }

  function removePhoto(personId: string, photoId: string) {
    setPeople((current) =>
      current.map((person) =>
        person.id === personId
          ? { ...person, photos: person.photos.filter((photo) => photo.id !== photoId) }
          : person,
      ),
    );
  }

  async function create() {
    if (creating) return;
    const errors = validatePersonFields({
      name: newName,
      about: newAbout,
      maxNameLength: props.maxNameLength,
      maxAboutLength: props.maxAboutLength,
    });
    setCreationErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setCreating(true);
    toast.dismiss(CREATE_KEY);
    const response = await fetch('/api/settings/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: newName, about: newAbout }),
    }).catch(() => null);
    if (!response?.ok) {
      toast.error(await peopleResponseMessage(response, 'Could not add this Person.'), {
        key: CREATE_KEY,
      });
      setCreating(false);
      return;
    }
    const body = (await response.json()) as { person: PersonSummary };
    setPeople((current) => [...current, { ...body.person, photos: [] }]);
    setNewName('');
    setNewAbout('');
    setAdding(false);
    setCreating(false);
    toast.success(`${body.person.name} added.`);
  }

  async function saveFrequency(next: CoverReferenceFrequency) {
    if (frequencyBusy || next === frequency) return;
    setFrequencyBusy(true);
    toast.dismiss(FREQUENCY_KEY);
    const response = await fetch('/api/settings/people', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ coverReferenceFrequency: next }),
    }).catch(() => null);
    if (!response?.ok) {
      toast.error(await peopleResponseMessage(response, 'Could not save the cover fallback.'), {
        key: FREQUENCY_KEY,
      });
      setFrequencyBusy(false);
      return;
    }
    setFrequency(next);
    router.refresh();
    setFrequencyBusy(false);
    toast.success('Cover fallback saved.');
  }

  // Sections only — the surrounding page owns the column flow, because the same
  // roster renders in Settings' two columns and in onboarding's single one.
  return (
    <>
      <SettingsSection
        title="Your People"
        action={
          <span className="font-mono text-[12px] tracking-[0.06em] text-dim">
            {people.length} of {props.maxPeople}
          </span>
        }
      >
        {people.map((person) => (
          <PersonEditor
            key={person.id}
            person={person}
            imageUrl={person.role === 'owner' ? props.ownerImageUrl : null}
            maxNameLength={props.maxNameLength}
            maxAboutLength={props.maxAboutLength}
            totalPhotoCount={totalPhotoCount}
            maxPhotosPerPerson={props.maxPhotosPerPerson}
            maxPhotosTotal={props.maxPhotosTotal}
            onUpdated={updatePerson}
            onDeleted={(personId) =>
              setPeople((current) => current.filter((person) => person.id !== personId))
            }
            onPhotoAdded={addPhoto}
            onPhotoRemoved={removePhoto}
          />
        ))}

        {adding ? (
          <SettingsCard className="mb-3 border-lamp/35">
            <div className="mb-4 font-display text-[16px] font-bold">New Person</div>
            <div className="space-y-4">
              <PersonFields
                name={newName}
                about={newAbout}
                maxNameLength={props.maxNameLength}
                maxAboutLength={props.maxAboutLength}
                disabled={creating}
                errors={creationErrors}
                onNameChange={(value) => {
                  setNewName(value);
                  setCreationErrors((current) => ({ ...current, name: undefined }));
                }}
                onAboutChange={(value) => {
                  setNewAbout(value);
                  setCreationErrors((current) => ({ ...current, about: undefined }));
                }}
              />
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className={secondaryButtonClass}
                disabled={creating}
                onClick={() => {
                  setAdding(false);
                  setCreationErrors({});
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={cn(primaryButtonClass, 'flex-1')}
                disabled={creating}
                onClick={create}
              >
                {creating ? 'Adding…' : 'Add Person'}
              </button>
            </div>
          </SettingsCard>
        ) : (
          <button
            type="button"
            className={`${secondaryButtonClass} w-full`}
            disabled={people.length >= props.maxPeople}
            onClick={() => setAdding(true)}
          >
            <Plus className="h-[17px] w-[17px]" aria-hidden />
            {people.length >= props.maxPeople
              ? `${props.maxPeople} of ${props.maxPeople} People added`
              : 'Add Person'}
          </button>
        )}
        <SettingsFootnote>
          JPEG, PNG, or WebP; two or three varied, clear, solo portraits per Person work best:
          visible face, useful lighting, front plus slight side angles. Avoid group photos, distant
          subjects, sunglasses, and heavy filters.
        </SettingsFootnote>
      </SettingsSection>

      <SettingsSection title="When nobody is named in the music prompt">
        <SettingsCard>
          <div className="text-[13px] font-semibold text-paper">Include the owner in Covers</div>
          <fieldset
            disabled={!fallbackReady}
            className={cn(segmentedListClass, 'mt-3 overflow-x-auto')}
          >
            <legend className="sr-only">Cover reference fallback frequency</legend>
            {COVER_FREQUENCY_OPTIONS.map((option) => (
              <label
                key={option.value}
                data-state={shownFrequency === option.value ? 'active' : 'inactive'}
                className={cn(
                  segmentedTriggerClass,
                  'min-w-[76px] cursor-pointer text-center has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-lamp',
                )}
              >
                <input
                  type="radio"
                  name="cover-reference-frequency"
                  value={option.value}
                  checked={shownFrequency === option.value}
                  disabled={frequencyBusy}
                  onChange={() => saveFrequency(option.value)}
                  className="sr-only"
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          {fallbackReady ? null : (
            <p className="mt-3 text-[11.5px] leading-[1.5] text-dim">
              <b className="text-muted">Add a reference photo to your own card above</b> to use
              this. Until then it stays on <b className="text-muted">Never</b>: putting you on a
              Cover takes a likeness of you, and another Person&apos;s photo cannot stand in for it.
            </p>
          )}
          <p className="mt-2 text-[11.5px] leading-[1.5] text-dim">
            <b className="text-muted">Never</b> is the privacy opt-out. A named Person can appear
            regardless of the fallback frequency. The choice saves as soon as you pick it.
          </p>
        </SettingsCard>
        <SettingsFootnote>
          Person names and About text stay private unless a matching request needs them. Named About
          text can inspire personalized lyrics for vocal requests when a Text AI is connected.
          Selected photos go only to the configured image provider for Cover generation; Never keeps
          every personal photo on this instance.
        </SettingsFootnote>
      </SettingsSection>
    </>
  );
}
