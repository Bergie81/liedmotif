'use client';

// The Sleep Timer picker: one slider in 5-minute steps, and the time it would
// set. A running timer is stated, and can be replaced or turned off here. It
// reads the provider's timer live, so one that runs out while the dialog is up
// reads as off.

import { useState } from 'react';
import { Dialog, DialogCloseButton, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { primaryButtonClass, secondaryButtonClass } from '@/components/ui/form-styles';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/cn';
import { usePlayerContext } from './player-provider';
import {
  SLEEP_TIMER_DEFAULT_MINUTES,
  SLEEP_TIMER_MAX_MINUTES,
  SLEEP_TIMER_MIN_MINUTES,
  SLEEP_TIMER_STEP_MINUTES,
  sleepTimerMinutesLeft,
} from './sleep-timer';

export function SleepTimerDialog({ onClose }: { onClose: () => void }) {
  const { sleepTimer } = usePlayerContext();
  const [minutes, setMinutes] = useState(SLEEP_TIMER_DEFAULT_MINUTES);
  const running = sleepTimer.endsAt !== null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent data-testid="sleep-timer-dialog" aria-describedby={undefined}>
        <DialogCloseButton />
        <DialogTitle className="pr-8 font-display text-[18px] font-bold tracking-[-0.01em]">
          Sleep Timer
        </DialogTitle>
        <p className="mt-2 text-[13.5px] leading-relaxed text-muted">
          {running
            ? `The music fades out and pauses in ${sleepTimerMinutesLeft(sleepTimer.endsAt, Date.now())} min.`
            : 'Fade out and pause the music after'}
        </p>
        <p className="mt-4 font-display text-[28px] font-bold tabular-nums text-paper">
          {minutes} min
        </p>
        <Slider
          className="mt-3"
          aria-label="Sleep Timer length in minutes"
          min={SLEEP_TIMER_MIN_MINUTES}
          max={SLEEP_TIMER_MAX_MINUTES}
          step={SLEEP_TIMER_STEP_MINUTES}
          value={[minutes]}
          onValueChange={([value]) => {
            if (value !== undefined) setMinutes(value);
          }}
        />
        <div className="mt-6 flex gap-2">
          <button
            type="button"
            data-testid="sleep-timer-off"
            className={cn(secondaryButtonClass, 'flex-1')}
            onClick={() => {
              if (running) sleepTimer.cancel();
              onClose();
            }}
          >
            {running ? 'Turn Off' : 'Cancel'}
          </button>
          <button
            type="button"
            data-testid="sleep-timer-start"
            className={cn(primaryButtonClass, 'flex-1')}
            onClick={() => {
              sleepTimer.start(minutes);
              onClose();
            }}
          >
            {running ? 'Restart Timer' : 'Start Timer'}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
