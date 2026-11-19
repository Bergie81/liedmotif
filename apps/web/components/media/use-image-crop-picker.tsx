'use client';

// One picker for every image upload surface: it owns the file input, the
// pre-decode validation, the crop dialog, and the byte cap on what is actually
// sent. A surface supplies its target and an upload function and renders its own
// button — everything between the tap and the upload is the same everywhere.

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { preparePickedImage, renderCroppedFile, type CropSource } from '@/lib/media/crop-image';
import type { PixelRect, Rotation } from '@/lib/media/crop-geometry';
import {
  IMAGE_UPLOAD_MIME_TYPES,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_PICKED_IMAGE_BYTES,
  isSupportedImageMimeType,
  megabytes,
  type ImageUploadTarget,
} from '@/lib/media/image-upload-targets';

// The crop dialog carries `react-easy-crop`; loading it lazily keeps the
// library out of every page bundle that merely OFFERS an upload (player,
// settings, playlists) — it fetches on the first actual pick, behind the
// file-picker interaction, so the delay is imperceptible.
const ImageCropDialog = dynamic(
  () => import('./image-crop-dialog').then((m) => m.ImageCropDialog),
  {
    ssr: false,
  },
);

/** The cropped file's name; the surfaces store no filename, only bytes. */
const CROPPED_FILENAME = 'upload.jpg';

export interface ImageCropPicker {
  /** Open the file picker. */
  pick: () => void;
  /** The hidden input and the crop dialog; render once inside the surface. */
  element: ReactNode;
  /** A crop is being rendered or uploaded. */
  busy: boolean;
}

export function useImageCropPicker({
  target,
  heading,
  confirmLabel,
  onUpload,
  onError,
}: {
  target: ImageUploadTarget;
  /** What is being framed, e.g. "Profile photo". */
  heading: string;
  confirmLabel?: string;
  /** Send the finished bytes; resolve to an error message, or null on success. */
  onUpload: (file: File) => Promise<string | null>;
  /**
   * Every failure the picker sees, and null when one clears. The surface says
   * it, as a toast above the crop dialog; the dialog itself never repeats it.
   */
  onError: (message: string | null) => void;
}): ImageCropPicker {
  const inputRef = useRef<HTMLInputElement>(null);
  /**
   * The picked file and the croppable working image built from it, held
   * together: a crop that changes nothing uploads the file itself, so the
   * original must stay reachable for as long as the dialog is open.
   */
  const [picked, setPicked] = useState<{ file: File; source: CropSource } | null>(null);
  const [busy, setBusy] = useState(false);

  const closeSource = useCallback(() => {
    setPicked((current) => {
      current?.source.release();
      return null;
    });
  }, []);

  // A dialog left open when the surface unmounts must not leak its bitmap.
  useEffect(() => closeSource, [closeSource]);

  const upload = useCallback(
    async (file: File): Promise<void> => {
      if (file.size > MAX_IMAGE_UPLOAD_BYTES) {
        onError(`The image is too large (${megabytes(MAX_IMAGE_UPLOAD_BYTES)} MB max).`);
        return;
      }
      setBusy(true);
      const failure = await onUpload(file);
      setBusy(false);
      onError(failure);
      if (!failure) closeSource();
    },
    [closeSource, onUpload, onError],
  );

  const onPicked = useCallback(
    async (file: File | undefined): Promise<void> => {
      if (!file || busy) return;
      onError(null);
      if (!isSupportedImageMimeType(file.type)) {
        onError('Use a JPEG, PNG, or WebP image.');
        return;
      }
      if (file.size > MAX_PICKED_IMAGE_BYTES) {
        onError(`That file is too large to process (${megabytes(MAX_PICKED_IMAGE_BYTES)} MB max).`);
        return;
      }
      const prepared = await preparePickedImage(file, target);
      if (prepared.kind === 'undecodable') {
        onError('That file could not be read as an image.');
        return;
      }
      // Pass-through: this browser cannot build a croppable working image from
      // it. The server still stores a correctly framed rendition.
      if (prepared.kind === 'pass-through') {
        await upload(file);
        return;
      }
      setPicked({ file, source: prepared.source });
    },
    [busy, onError, target, upload],
  );

  const confirm = useCallback(
    async (crop: PixelRect, rotation: Rotation): Promise<void> => {
      if (!picked) return;
      onError(null);
      // Busy from the tap on: rendering the crop takes long enough on a phone
      // for a second tap to upload the image twice.
      setBusy(true);
      // A canvas the browser refuses (memory pressure) throws instead of
      // returning null; either way the dialog must leave its busy state.
      const cropped = await renderCroppedFile({
        source: picked.source,
        original: picked.file,
        crop,
        rotation,
        target,
        filename: CROPPED_FILENAME,
      }).catch(() => null);
      setBusy(false);
      if (!cropped) {
        onError('The crop could not be rendered. Try a different image.');
        return;
      }
      await upload(cropped);
    },
    [picked, onError, target, upload],
  );

  return {
    pick: () => inputRef.current?.click(),
    busy,
    element: (
      <>
        <input
          ref={inputRef}
          type="file"
          accept={IMAGE_UPLOAD_MIME_TYPES.join(',')}
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            // Clear first: picking the SAME file again must fire `change`.
            event.target.value = '';
            void onPicked(file);
          }}
        />
        {picked ? (
          <ImageCropDialog
            source={picked.source}
            target={target}
            heading={heading}
            {...(confirmLabel ? { confirmLabel } : {})}
            busy={busy}
            onConfirm={(crop, rotation) => void confirm(crop, rotation)}
            onCancel={() => {
              onError(null);
              closeSource();
            }}
          />
        ) : null}
      </>
    ),
  };
}
