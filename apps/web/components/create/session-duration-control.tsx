'use client';

import { useId } from 'react';

/** Longer targets stay valid; the slider pins them to its end while the label keeps the exact value. */
const SLIDER_MAX_MINUTES = 180;

function minutesLabel(minutes: number | null): string {
  return minutes == null ? 'No limit' : `${minutes} min`;
}

export function SessionDurationControl({
  value,
  onChange,
  auto,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  /**
   * Makes the left stop Auto (the server decides the target) instead of No
   * limit. `defaultMinutes` is the user's Default Session duration Auto falls
   * back to; null is No limit.
   */
  auto?: { defaultMinutes: number | null };
}) {
  const id = useId();
  const label =
    value == null && auto ? `Auto · ${minutesLabel(auto.defaultMinutes)}` : minutesLabel(value);
  return (
    <div>
      <label htmlFor={id} className="mb-2 flex justify-between text-[15px] font-semibold">
        Session duration <output className="font-mono text-[11px] text-lamp">{label}</output>
      </label>
      <input
        id={id}
        type="range"
        min={0}
        max={SLIDER_MAX_MINUTES}
        step={5}
        value={value == null ? 0 : Math.min(SLIDER_MAX_MINUTES, value)}
        aria-valuetext={label}
        onChange={(event) => onChange(Number(event.target.value) || null)}
        className="w-full accent-lamp-fill"
      />
      {/* Only the create screen has a prompt a duration could come from. */}
      {auto ? (
        <div className="mt-2 text-[11.5px] leading-[1.5] text-dim">
          <p>A selected duration overrides any duration in your prompt.</p>
          <p className="mt-1">
            Auto uses a duration from your prompt when a text AI is connected, otherwise your
            default. Change the default in Settings → Generation.
          </p>
        </div>
      ) : null}
    </div>
  );
}
