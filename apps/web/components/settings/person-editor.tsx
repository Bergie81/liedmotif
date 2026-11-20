'use client';

import { useState } from 'react';
import { AvatarBadge } from '@/components/avatar-badge';
import { cn } from '@/lib/cn';
import type { PersonSummary } from '@/lib/settings/people';
import { toast } from '@/lib/toast';
import type { PersonReferencePhotoSummary } from '@/lib/settings/person-reference-photos';
import { compactPrimaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { dangerButtonClass } from '@/components/ui/design-system';
import { PersonFields } from './person-fields';
import { validatePersonFields, type PersonFieldErrors } from './people-form-model';
import { PersonPhotos } from './person-photos';
import { SettingsCard } from './settings-ui';
import { peopleResponseMessage, type PersonEditorValue } from './people-types';

export function PersonEditor({
  person,
  imageUrl = null,
  maxNameLength,
  maxAboutLength,
  totalPhotoCount,
  maxPhotosPerPerson,
  maxPhotosTotal,
  onUpdated,
  onDeleted,
  onPhotoAdded,
  onPhotoRemoved,
}: {
  person: PersonEditorValue;
  /** The owner's profile photo, which identifies their card ahead of an initial. */
  imageUrl?: string | null;
  maxNameLength: number;
  maxAboutLength: number;
  totalPhotoCount: number;
  maxPhotosPerPerson: number;
  maxPhotosTotal: number;
  onUpdated: (person: PersonSummary) => void;
  onDeleted: (personId: string) => void;
  onPhotoAdded: (personId: string, photo: PersonReferencePhotoSummary) => void;
  onPhotoRemoved: (personId: string, photoId: string) => void;
}) {
  const [name, setName] = useState(person.name);
  const [about, setAbout] = useState(person.about);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<PersonFieldErrors>({});
  const saveKey = `person-save:${person.id}`;
  const deleteKey = `person-delete:${person.id}`;

  async function save() {
    if (busy || photoBusy) return;
    const errors = validatePersonFields({ name, about, maxNameLength, maxAboutLength });
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;
    setBusy('save');
    toast.dismiss(saveKey);
    const response = await fetch(`/api/settings/people/${person.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, about }),
    }).catch(() => null);
    if (!response?.ok) {
      toast.error(await peopleResponseMessage(response, 'Could not save this person.'), {
        key: saveKey,
      });
      setBusy(null);
      return;
    }
    const body = (await response.json()) as { person: PersonSummary };
    onUpdated(body.person);
    setName(body.person.name);
    setAbout(body.person.about);
    toast.success(`${body.person.name} saved.`);
    setBusy(null);
  }

  async function remove() {
    if (busy || photoBusy || person.role === 'owner') return;
    if (!window.confirm(`Delete ${person.name}? Their private reference photos will be removed.`)) {
      return;
    }
    setBusy('delete');
    toast.dismiss(deleteKey);
    const response = await fetch(`/api/settings/people/${person.id}`, {
      method: 'DELETE',
    }).catch(() => null);
    if (!response?.ok) {
      toast.error(await peopleResponseMessage(response, 'Could not delete this person.'), {
        key: deleteKey,
      });
      setBusy(null);
      return;
    }
    onDeleted(person.id);
  }

  const operationPending = busy !== null || photoBusy;
  return (
    <SettingsCard className="mb-3">
      <div className="mb-4 flex items-center gap-3">
        {/* A Person may have no name yet, and `?` says that better than the listener
            fallback letter does. */}
        <AvatarBadge
          name={person.name.trim() || '?'}
          imageUrl={imageUrl}
          className="h-[34px] w-[34px] text-[14px]"
        />
        <span className="min-w-0 flex-1 truncate font-display text-[16px] font-bold tracking-[-0.01em]">
          {person.name || 'Unnamed Person'}
        </span>
        {person.role === 'owner' ? (
          <span className="rounded-[5px] border border-lamp/45 px-2 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.1em] text-lamp">
            Owner Profile
          </span>
        ) : null}
      </div>
      <div className="space-y-4">
        <PersonFields
          name={name}
          about={about}
          isOwner={person.role === 'owner'}
          maxNameLength={maxNameLength}
          maxAboutLength={maxAboutLength}
          disabled={operationPending}
          errors={fieldErrors}
          onNameChange={(value) => {
            setName(value);
            setFieldErrors((current) => ({ ...current, name: undefined }));
          }}
          onAboutChange={(value) => {
            setAbout(value);
            setFieldErrors((current) => ({ ...current, about: undefined }));
          }}
        />
        <PersonPhotos
          person={person}
          totalPhotoCount={totalPhotoCount}
          maxPhotosPerPerson={maxPhotosPerPerson}
          maxPhotosTotal={maxPhotosTotal}
          disabled={busy !== null}
          onBusyChange={setPhotoBusy}
          onPhotoAdded={onPhotoAdded}
          onPhotoRemoved={onPhotoRemoved}
        />
      </div>
      <div className="mt-4 flex gap-2">
        {person.role === 'ordinary' ? (
          <button
            type="button"
            onClick={remove}
            disabled={operationPending}
            className={cn(dangerButtonClass, 'rounded-[10px] px-4 py-2 text-[13.5px]')}
          >
            {busy === 'delete' ? 'Deleting…' : 'Delete'}
          </button>
        ) : null}
        <button
          type="button"
          onClick={save}
          disabled={operationPending}
          className={cn(
            person.role === 'ordinary' ? compactPrimaryButtonClass : secondaryButtonClass,
            'flex-1',
          )}
        >
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
    </SettingsCard>
  );
}
