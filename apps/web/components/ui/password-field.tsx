'use client';

// The labelled input every user password is typed into, with a reveal toggle.
// The toggle sits outside the <label> so its name never joins the input's, and
// it is a plain button so it never submits the form around it.

import { useId, useState, type ChangeEvent, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { MAX_PASSWORD_LENGTH } from '@liedmotif/shared';
import { FieldNote, fieldNoteId } from '@/components/ui/field-note';
import { inputClass, labelClass } from '@/components/ui/form-styles';
import { cn } from '@/lib/cn';

export function PasswordField({
  label,
  hint,
  error,
  ...inputProps
}: Omit<ComponentProps<'input'>, 'id' | 'type' | 'className'> & {
  label: string;
  hint?: string;
  error?: string;
}) {
  const inputId = useId();
  const [revealed, setRevealed] = useState(false);
  return (
    <div className={labelClass}>
      <label htmlFor={inputId}>{label}</label>
      <div className="relative">
        <input
          maxLength={MAX_PASSWORD_LENGTH}
          {...inputProps}
          id={inputId}
          type={revealed ? 'text' : 'password'}
          // Revealed, it is a text input: phone keyboards would capitalize and
          // correct the password, and browser spelling services would read it.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? fieldNoteId(inputId) : undefined}
          // Edge draws its own reveal eye inside password inputs.
          className={cn(inputClass, 'pr-12 [&::-ms-reveal]:hidden')}
        />
        <button
          type="button"
          aria-label={revealed ? 'Hide Password' : 'Show Password'}
          aria-pressed={revealed}
          onClick={() => setRevealed((current) => !current)}
          className="absolute right-2 top-1/2 grid h-8 w-8 -translate-y-1/2 place-items-center rounded-[9px] text-dim transition-colors duration-[120ms] hover:text-paper"
        >
          {revealed ? (
            <EyeOff className="h-[18px] w-[18px]" aria-hidden />
          ) : (
            <Eye className="h-[18px] w-[18px]" aria-hidden />
          )}
        </button>
      </div>
      <FieldNote inputId={inputId} error={error} hint={hint} />
    </div>
  );
}

/**
 * The repeat field under every new password: a typo there locks the account
 * out, so the password is typed twice. A mismatch shows from the first blur of
 * a filled repeat field or the first submit, then follows both fields live.
 */
export function usePasswordConfirmation(password: string) {
  const [value, setValue] = useState('');
  const [showMismatch, setShowMismatch] = useState(false);
  const matches = value === password;
  return {
    /** For the submit: shows any mismatch and answers whether the two match. */
    check(): boolean {
      setShowMismatch(true);
      return matches;
    },
    /** Spread onto the repeat field's `PasswordField`. */
    field: {
      value,
      error: showMismatch && !matches ? 'Passwords do not match.' : undefined,
      onChange: (event: ChangeEvent<HTMLInputElement>) => setValue(event.target.value),
      onBlur: () => {
        if (value) setShowMismatch(true);
      },
    },
  };
}
