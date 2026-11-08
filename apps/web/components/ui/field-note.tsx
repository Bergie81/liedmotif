// The line under a form field: its error, else its hint. Its id
// (`fieldNoteId`) is what the input's `aria-describedby` names, so a screen
// reader reads the note with the field.

import { cn } from '@/lib/cn';

export function fieldNoteId(inputId: string): string {
  return `${inputId}-note`;
}

export function FieldNote({
  inputId,
  error,
  hint,
}: {
  inputId: string;
  error?: string;
  hint?: string;
}) {
  const note = error || hint;
  if (!note) return null;
  return (
    <span
      id={fieldNoteId(inputId)}
      className={cn('text-[11.5px] font-normal', error ? 'text-warn' : 'leading-[1.5] text-dim')}
    >
      {note}
    </span>
  );
}
