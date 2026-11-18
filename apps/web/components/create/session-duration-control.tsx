'use client';

import { useId } from 'react';

/** Longer targets stay valid; the slider pins them to its end while the label keeps the exact value. */
const SLIDER_MAX_MINUTES = 180;

function durationLabel(value: number | null, auto: boolean): string {
  if (value != null) return `${value} min`;
  return auto ? 'Auto' : 'No limit';
}

export function SessionDurationControl({
  value,
  onChange,
  auto = false,
}: {
  value: number | null;
  onChange: (value: number | null) => void;
  auto?: boolean;
}) {
  const id = useId();
  const label = durationLabel(value, auto);
  return (
    <div>
      <label htmlFor={id} className="mb-2 flex justify-between text-[13px] font-semibold">
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
            Auto detects an explicit duration in your prompt when a Text AI is connected. Without
            one, generation stays continuous.
          </p>
        </div>
      ) : null}
    </div>
  );
}
