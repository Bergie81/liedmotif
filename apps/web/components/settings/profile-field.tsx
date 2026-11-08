// The labelled profile input, shared by Settings → Profile and the first-login
// onboarding step so both surfaces carry the same optional marker, hint slot, and
// error presentation.

import { useId, type ReactNode } from 'react';
import { FieldNote, fieldNoteId } from '@/components/ui/field-note';
import { inputClass, labelClass } from '@/components/ui/form-styles';
import { cn } from '@/lib/cn';

export function ProfileField({
  label,
  labelAccessory,
  type = 'text',
  inputMode,
  value,
  maxLength,
  autoComplete,
  optional,
  /** Replaces the OPTIONAL marker — e.g. where a value came from. */
  badge,
  placeholder,
  hint,
  error,
  disabled,
  readOnly,
  onChange,
}: {
  label: string;
  /** Sits at the end of the label row, outside the <label>, so a control in it never joins the input's name. */
  labelAccessory?: ReactNode;
  type?: 'text' | 'email';
  inputMode?: 'decimal';
  value: string;
  maxLength: number;
  autoComplete?: string;
  optional?: boolean;
  badge?: string;
  placeholder?: string;
  hint?: string;
  error?: string;
  disabled?: boolean;
  readOnly?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const marker = badge ?? (optional ? 'OPTIONAL' : null);
  return (
    <div className={labelClass}>
      <span className="flex items-center justify-between gap-2">
        <label htmlFor={id}>{label}</label>
        {labelAccessory || marker ? (
          <span className="flex flex-wrap items-center justify-end gap-2">
            {labelAccessory}
            {marker ? (
              <span className="font-mono text-[11px] font-normal tracking-[0.04em] text-dim">
                {marker}
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        maxLength={maxLength}
        autoComplete={autoComplete}
        placeholder={placeholder}
        disabled={disabled}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? fieldNoteId(id) : undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn(inputClass, readOnly && 'text-muted')}
      />
      <FieldNote inputId={id} error={error} hint={hint} />
    </div>
  );
}
