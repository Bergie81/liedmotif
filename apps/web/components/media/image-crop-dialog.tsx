'use client';

// The one crop step every image upload passes through. It shows the picked
// photo under the surface's own frame — round for the avatar, square for a
// cover, portrait for a reference photo — and reports the confirmed region in
// the working image's pixels. Framing is deliberate here because it is final:
// the original is never stored, so re-cropping later means uploading again.
//
// Mounted only while a picked image exists, so every open starts from a neutral
// crop rather than the last one's.

import { useState } from 'react';
import Cropper, { type Area } from 'react-easy-crop';
import { RotateCw } from 'lucide-react';
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { Slider } from '@/components/ui/slider';
import { maxCropZoom, rotatedSize, type PixelRect, type Rotation } from '@/lib/media/crop-geometry';
import type { CropSource } from '@/lib/media/crop-image';
import type { ImageUploadTarget } from '@/lib/media/image-upload-targets';
import { cn } from '@/lib/cn';

const ZOOM_STEPS = 100;

export function ImageCropDialog({
  source,
  target,
  heading,
  confirmLabel = 'Use photo',
  busy,
  onConfirm,
  onCancel,
}: {
  source: CropSource;
  target: ImageUploadTarget;
  /** What is being framed, e.g. "Profile photo" / "Session cover". */
  heading: string;
  confirmLabel?: string;
  /** The caller's upload is running; the dialog stays open until it settles. */
  busy: boolean;
  onConfirm: (crop: PixelRect, rotation: Rotation) => void;
  onCancel: () => void;
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState<Rotation>(0);
  const [area, setArea] = useState<PixelRect | null>(null);

  // A quarter turn swaps the frame the crop is measured against, so the zoom
  // ceiling belongs to the rotation — and a turn that lowers it must pull the
  // current zoom down with it, or the crop would fall below the output target.
  function zoomCeiling(at: Rotation): number {
    return maxCropZoom(rotatedSize(source.size, at), target);
  }

  const maxZoom = zoomCeiling(rotation);
  const zoomLocked = maxZoom <= 1;

  function rotate() {
    const next = ((rotation + 90) % 360) as Rotation;
    setRotation(next);
    setZoom((current) => Math.min(current, zoomCeiling(next)));
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !busy && onCancel()}>
      <DialogContent
        data-testid="image-crop-dialog"
        aria-describedby={undefined}
        className="max-h-[90vh] overflow-y-auto"
      >
        <DialogCloseButton disabled={busy} />

        <div className="px-8 text-center">
          <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-lamp">{heading}</p>
          <DialogTitle className="mt-1 font-display text-[22px] font-extrabold leading-[1.2] tracking-[-0.02em] text-paper">
            Frame your image
          </DialogTitle>
        </div>

        {/* react-easy-crop fills its nearest positioned ancestor. */}
        <div className="relative mt-4 h-[300px] overflow-hidden rounded-card-sm bg-ink">
          <Cropper
            image={source.url}
            crop={crop}
            zoom={zoom}
            rotation={rotation}
            aspect={target.aspect}
            cropShape={target.shape}
            minZoom={1}
            maxZoom={maxZoom}
            showGrid={target.shape !== 'round'}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={(_area: Area, pixels: Area) => setArea(pixels)}
          />
        </div>

        <div className="mt-4 flex items-center gap-4">
          {/* A pan-only source leaves no range to slide, and a zero-width range
              (or a zero step) is not a valid Slider — hence the nominal ones. */}
          <Slider
            value={[zoom]}
            min={1}
            max={Math.max(maxZoom, 1 + 1 / ZOOM_STEPS)}
            step={(maxZoom - 1) / ZOOM_STEPS || 1}
            disabled={zoomLocked || busy}
            aria-label="Zoom"
            onValueChange={([next]) => setZoom(next ?? 1)}
            className={cn('flex-1', zoomLocked && 'opacity-40')}
          />
          <button
            type="button"
            disabled={busy}
            aria-label="Rotate 90 degrees"
            data-testid="image-crop-rotate"
            onClick={rotate}
            className={secondaryButtonClass}
          >
            <RotateCw className="h-4 w-4" aria-hidden />
          </button>
        </div>

        <p className="mt-2 text-[11.5px] leading-[1.5] text-dim">
          Drag to move, pinch or zoom to fill the frame. Only this crop is uploaded — the original
          is not kept, so re-cropping later means uploading again.
        </p>

        <div className="mt-4 flex items-stretch gap-2">
          <button
            type="button"
            data-testid="image-crop-confirm"
            disabled={busy || !area}
            onClick={() => area && onConfirm(area, rotation)}
            className={cn(primaryButtonClass, 'flex-1')}
          >
            {busy ? 'Uploading…' : confirmLabel}
          </button>
          <button type="button" disabled={busy} onClick={onCancel} className={secondaryButtonClass}>
            Cancel
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
