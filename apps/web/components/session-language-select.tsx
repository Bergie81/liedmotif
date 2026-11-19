'use client';

// The ONE Select both language surfaces render (Settings → Generation's default
// and the create card's Fine Tune fold), so the option list and its pinned
// order — Auto Detect, English, then A–Z — can never drift between them.
// Callers own their surrounding label markup.

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  SESSION_LANGUAGE_CHOICES,
  sessionLanguageLabel,
  type SessionLanguageChoice,
} from '@/lib/sessions/session-languages';

export function SessionLanguageSelect({
  value,
  onChange,
  ariaLabel,
  testId,
  triggerClassName,
  autoLabel,
}: {
  value: SessionLanguageChoice;
  onChange: (value: SessionLanguageChoice) => void;
  ariaLabel: string;
  testId: string;
  triggerClassName?: string;
  /** What `auto` means on this surface; defaults to Auto Detect. */
  autoLabel?: string;
}) {
  return (
    <Select value={value} onValueChange={(next) => onChange(next as SessionLanguageChoice)}>
      <SelectTrigger aria-label={ariaLabel} data-testid={testId} className={triggerClassName}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent className="w-[var(--radix-select-trigger-width)]">
        {SESSION_LANGUAGE_CHOICES.map((choice) => (
          <SelectItem key={choice} value={choice}>
            {choice === 'auto' && autoLabel ? autoLabel : sessionLanguageLabel(choice)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
