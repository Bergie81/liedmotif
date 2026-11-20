'use client';

import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { stepperButtonClass, stepperClass, stepperValueClass, switchClass } from './design-system';

export function Switch({
  checked,
  onCheckedChange,
  className,
  disabled,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-checked' | 'onChange' | 'onClick' | 'role'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      {...props}
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      className={cn(switchClass, className)}
      onClick={() => onCheckedChange(!checked)}
    />
  );
}

export function Stepper({
  value,
  onDecrement,
  onIncrement,
  decrementLabel = 'Decrease Value',
  incrementLabel = 'Increase Value',
  canDecrement = true,
  canIncrement = true,
  className,
}: {
  value: ReactNode;
  onDecrement: () => void;
  onIncrement: () => void;
  decrementLabel?: string;
  incrementLabel?: string;
  canDecrement?: boolean;
  canIncrement?: boolean;
  className?: string;
}) {
  return (
    <div className={cn(stepperClass, className)}>
      <button
        type="button"
        aria-label={decrementLabel}
        disabled={!canDecrement}
        className={stepperButtonClass}
        onClick={onDecrement}
      >
        −
      </button>
      <output className={stepperValueClass} aria-live="polite">
        {value}
      </output>
      <button
        type="button"
        aria-label={incrementLabel}
        disabled={!canIncrement}
        className={stepperButtonClass}
        onClick={onIncrement}
      >
        +
      </button>
    </div>
  );
}
