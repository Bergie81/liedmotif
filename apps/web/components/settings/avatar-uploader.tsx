'use client';

// Upload-on-confirm avatar control: picking a file opens the round crop frame,
// and confirming uploads it immediately (independent of the "Save profile"
// button), with a router.refresh() on success so the account chip updates
// everywhere.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageUp, Trash2 } from 'lucide-react';
import { AvatarBadge } from '@/components/avatar-badge';
import { useImageCropPicker } from '@/components/media/use-image-crop-picker';
import { AVATAR_UPLOAD, MAX_IMAGE_UPLOAD_BYTES, megabytes } from '@/lib/media/image-upload-targets';
import { secondaryButtonClass } from '@/components/ui/form-styles';
import { toast } from '@/lib/toast';

type AvatarResponse = {
  ok?: boolean;
  data?: { imageUrl: string | null };
  error?: { message?: string };
};

const MAX_UPLOAD_MB = megabytes(MAX_IMAGE_UPLOAD_BYTES);
const FAILURE_KEY = 'avatar-update';

/** The picker reports null when a failure clears: a new pick, a retry, a cancel. */
function report(message: string | null) {
  if (message) toast.error(message, { key: FAILURE_KEY });
  else toast.dismiss(FAILURE_KEY);
}

export function AvatarUploader({
  name,
  initialImageUrl,
  onImageChange,
}: {
  name: string;
  initialImageUrl: string | null;
  /**
   * The stored photo changed. `router.refresh()` already carries it to every server
   * surface; this is for a client one that must not wait for that round trip — the
   * onboarding wizard shows the same photo on its next step.
   */
  onImageChange?: (imageUrl: string | null) => void;
}) {
  const router = useRouter();
  const [imageUrl, setImageUrl] = useState(initialImageUrl);
  const [busy, setBusy] = useState(false);

  /** Send the request; resolves to an error message, or null on success. */
  async function submitAvatar(init: RequestInit): Promise<string | null> {
    setBusy(true);
    toast.dismiss(FAILURE_KEY);
    const response = await fetch('/api/settings/profile/avatar', init).catch(() => null);
    const body: AvatarResponse = response
      ? ((await response.json().catch(() => ({}))) as AvatarResponse)
      : {};
    setBusy(false);
    if (response?.ok && body.ok && body.data) {
      setImageUrl(body.data.imageUrl);
      onImageChange?.(body.data.imageUrl);
      router.refresh();
      return null;
    }
    return body.error?.message ?? 'Could not update the photo.';
  }

  const picker = useImageCropPicker({
    target: AVATAR_UPLOAD,
    heading: 'Profile Photo',
    onError: report,
    onUpload: (file) => {
      const form = new FormData();
      form.set('file', file);
      return submitAvatar({ method: 'POST', body: form });
    },
  });

  async function removeAvatar() {
    report(await submitAvatar({ method: 'DELETE' }));
  }

  const working = busy || picker.busy;
  return (
    <div className="flex items-center gap-4">
      <AvatarBadge name={name} imageUrl={imageUrl} className="h-16 w-16 text-[24px]" />
      <div className="min-w-0 space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={working}
            onClick={picker.pick}
            className={secondaryButtonClass}
          >
            <ImageUp className="h-4 w-4" aria-hidden />
            {working ? 'Working…' : imageUrl ? 'Change Photo' : 'Upload Photo'}
          </button>
          {imageUrl ? (
            <button
              type="button"
              disabled={working}
              onClick={() => void removeAvatar()}
              className={secondaryButtonClass}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              Remove
            </button>
          ) : null}
          {picker.element}
        </div>
        <p className="text-[11.5px] leading-[1.5] text-dim">
          JPEG, PNG, or WebP, {MAX_UPLOAD_MB} MB max.
        </p>
      </div>
    </div>
  );
}
