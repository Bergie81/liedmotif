'use client';

import { useEffect, useState } from 'react';
import { listenerInitial } from '@/lib/avatar';
import { cn } from '@/lib/cn';
import { roundChipClass } from './ui/design-system';

/** The round identity chip: the avatar image, or the name's initial without one. */
export function AvatarBadge({
  name,
  imageUrl,
  className,
}: {
  name: string;
  imageUrl: string | null;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [imageUrl]);
  const showImage = imageUrl !== null && !failed;
  return (
    <span
      className={cn(
        roundChipClass,
        'overflow-hidden font-display font-bold leading-none text-lamp',
        className,
      )}
    >
      {showImage ? (
        <img
          src={imageUrl}
          alt=""
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      ) : (
        listenerInitial(name)
      )}
    </span>
  );
}
