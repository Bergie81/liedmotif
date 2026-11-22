'use client';

import type { CoverStyleChoice } from '@liedmotif/shared';
import { COVER_STYLE_EXPLANATIONS, COVER_STYLE_LABELS } from '@/lib/covers/cover-styles';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { CoverStyleTile } from './cover-style-tile';

/**
 * The cover style dropdown of the create card and the cover sheets. From the
 * desktop breakpoint up each option shows the style's example tile and
 * one-line explanation; a phone keeps the plain list of names, where nine
 * illustrated options would not fit a sheet. The closed dropdown always shows
 * the name alone.
 */
export function CoverStyleSelect<T extends CoverStyleChoice>({
  choices,
  value,
  onChange,
  disabled,
  testId,
}: {
  choices: readonly T[];
  value: T;
  onChange: (value: T) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as T)} disabled={disabled}>
      <SelectTrigger aria-label="Cover style" data-testid={testId} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-[var(--radix-select-trigger-width)] desk:max-h-[min(580px,var(--radix-select-content-available-height))]">
        {choices.map((choice) => (
          <SelectItem
            key={choice}
            value={choice}
            media={
              <span className="hidden desk:block">
                <CoverStyleTile choice={choice} size="option" />
              </span>
            }
            description={
              <span className="hidden text-[12px] leading-[1.4] text-dim desk:block">
                {COVER_STYLE_EXPLANATIONS[choice]}
              </span>
            }
          >
            {COVER_STYLE_LABELS[choice]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
