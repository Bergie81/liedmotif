'use client';

import { inputClass, labelClass } from '@/components/ui/form-styles';
import type { PersonFieldErrors } from './people-form-model';

export function PersonFields({
  name,
  about,
  isOwner = false,
  maxNameLength,
  maxAboutLength,
  disabled,
  errors,
  onNameChange,
  onAboutChange,
}: {
  name: string;
  about: string;
  isOwner?: boolean;
  maxNameLength: number;
  maxAboutLength: number;
  disabled: boolean;
  errors?: PersonFieldErrors;
  onNameChange: (value: string) => void;
  onAboutChange: (value: string) => void;
}) {
  return (
    <>
      <label className={labelClass}>
        Name
        <input
          className={inputClass}
          value={name}
          required
          maxLength={maxNameLength}
          disabled={disabled}
          aria-invalid={errors?.name ? true : undefined}
          onChange={(event) => onNameChange(event.target.value)}
        />
        {errors?.name ? (
          <span className="text-[11.5px] font-normal text-warn">{errors.name}</span>
        ) : (
          <span className="text-[11.5px] font-normal leading-[1.5] text-dim">
            {isOwner
              ? 'You don’t need to type it. With a Writing AI, a request that puts you in the scene, like “with Jonas on the way to Berlin”, includes you.'
              : 'Use this name in your music request exactly as written to include this Person. Choose a distinctive name; relationships and translations are not inferred.'}
          </span>
        )}
      </label>
      <label className={labelClass}>
        <span className="flex items-baseline justify-between gap-2">
          {isOwner ? 'About you' : 'About them'}
          <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
            {about.length}/{maxAboutLength}
          </span>
        </span>
        <textarea
          className={`${inputClass} resize-none leading-[1.5]`}
          value={about}
          rows={3}
          maxLength={maxAboutLength}
          disabled={disabled}
          aria-invalid={errors?.about ? true : undefined}
          onChange={(event) => onAboutChange(event.target.value)}
        />
        {errors?.about ? (
          <span className="text-[11.5px] font-normal text-warn">{errors.about}</span>
        ) : (
          <span className="text-[11.5px] font-normal leading-[1.5] text-dim">
            {isOwner
              ? 'Optional. With a Writing AI, it shapes the lyrics of every vocal Session.'
              : 'Optional context for vocal lyrics when you name them.'}
          </span>
        )}
      </label>
    </>
  );
}
