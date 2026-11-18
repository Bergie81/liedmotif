'use client';

import { useState } from 'react';
import { Trash2, Upload } from 'lucide-react';
import { useImageCropPicker } from '@/components/media/use-image-crop-picker';
import { REFERENCE_PHOTO_UPLOAD } from '@/lib/image-upload-targets';
import type { PersonReferencePhotoSummary } from '@/lib/person-reference-photos';
import { toast } from '@/lib/toast';
import { peopleErrorMessage, peopleResponseMessage, type PersonEditorValue } from './people-types';

export function PersonPhotos({
  person,
  totalPhotoCount,
  maxPhotosPerPerson,
  maxPhotosTotal,
  disabled,
  onBusyChange,
  onPhotoAdded,
  onPhotoRemoved,
}: {
  person: PersonEditorValue;
  totalPhotoCount: number;
  maxPhotosPerPerson: number;
  maxPhotosTotal: number;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
  onPhotoAdded: (personId: string, photo: PersonReferencePhotoSummary) => void;
  onPhotoRemoved: (personId: string, photoId: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const errorKey = `person-photos:${person.id}`;
  /** The picker reports null when a failure clears: a new pick, a retry, a cancel. */
  function report(message: string | null) {
    if (message) toast.error(message, { key: errorKey });
    else toast.dismiss(errorKey);
  }
  const atPersonCap = person.photos.length >= maxPhotosPerPerson;
  const atTotalCap = totalPhotoCount >= maxPhotosTotal;
  const blocked = disabled || busy;

  // The 3:4 frame is mandatory: the image model spends a fixed attention budget
  // per reference, so the owner decides which part of the photo it is spent on.
  const picker = useImageCropPicker({
    target: REFERENCE_PHOTO_UPLOAD,
    heading: 'Reference photo',
    onError: report,
    onUpload: async (file) => {
      setBusy(true);
      onBusyChange(true);
      report(null);
      const form = new FormData();
      form.set('file', file);
      const response = await fetch(`/api/settings/people/${person.id}/photos`, {
        method: 'POST',
        body: form,
      }).catch(() => null);
      const body = response
        ? ((await response.json().catch(() => null)) as {
            ok?: boolean;
            data?: { photo?: PersonReferencePhotoSummary };
            error?: string | { message?: string };
          } | null)
        : null;
      setBusy(false);
      onBusyChange(false);
      if (response?.ok && body?.ok && body.data?.photo) {
        onPhotoAdded(person.id, body.data.photo);
        return null;
      }
      return peopleErrorMessage(body, 'The reference photo could not be processed.');
    },
  });

  async function remove(photo: PersonReferencePhotoSummary) {
    if (blocked) return;
    setBusy(true);
    onBusyChange(true);
    report(null);
    const response = await fetch(`/api/settings/people/${person.id}/photos/${photo.id}`, {
      method: 'DELETE',
    }).catch(() => null);
    setBusy(false);
    onBusyChange(false);
    if (response?.ok) {
      onPhotoRemoved(person.id, photo.id);
      return;
    }
    report(await peopleResponseMessage(response, 'The reference photo could not be removed.'));
  }

  return (
    <div className="border-t border-line pt-4">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-[13px] font-semibold text-paper">Reference photos</span>
        <span className="text-right font-mono text-[10px] uppercase tracking-[0.08em] text-dim">
          {person.photos.length}/{maxPhotosPerPerson} for this Person · {totalPhotoCount}/
          {maxPhotosTotal} total
        </span>
      </div>
      <div className="grid grid-cols-[repeat(3,1fr)] gap-2">
        {person.photos.map((photo) => (
          <ReferencePhoto
            key={photo.id}
            personName={person.name}
            photo={photo}
            disabled={blocked}
            onRemove={() => remove(photo)}
          />
        ))}
        {!atPersonCap && !atTotalCap ? (
          <button
            type="button"
            disabled={blocked}
            onClick={picker.pick}
            className="flex aspect-square flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed border-line-2 font-mono text-[9.5px] uppercase tracking-[0.1em] text-dim hover:border-lamp/50 hover:text-lamp disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Upload className="h-[17px] w-[17px]" aria-hidden />
            {busy ? 'Processing' : 'Upload'}
          </button>
        ) : null}
      </div>
      {picker.element}
      {atPersonCap || atTotalCap ? (
        <p className="mt-2 text-[11.5px] text-dim">
          Photo limit reached. Delete a photo to add another.
        </p>
      ) : null}
    </div>
  );
}

function ReferencePhoto({
  personName,
  photo,
  disabled,
  onRemove,
}: {
  personName: string;
  photo: PersonReferencePhotoSummary;
  disabled: boolean;
  onRemove: () => void;
}) {
  const [previewFailed, setPreviewFailed] = useState(false);
  return (
    <div className="relative overflow-hidden rounded-[10px] border border-line">
      {previewFailed ? (
        <div className="grid aspect-square place-items-center bg-paper/[0.03] p-2 text-center text-[10px] text-dim">
          Preview unavailable
        </div>
      ) : (
        <img
          src={photo.imageUrl}
          alt={`${personName} reference`}
          className="aspect-square w-full object-cover"
          onError={() => setPreviewFailed(true)}
        />
      )}
      <button
        type="button"
        disabled={disabled}
        aria-label={`Delete ${personName} reference photo`}
        onClick={onRemove}
        className="absolute right-1 top-1 grid h-[26px] w-[26px] place-items-center rounded-[7px] bg-ink/70 text-paper backdrop-blur-[4px] hover:text-warn disabled:opacity-45"
      >
        <Trash2 className="h-[13px] w-[13px]" aria-hidden />
      </button>
    </div>
  );
}
