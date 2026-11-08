import { getPageIdentity } from '@/components/app-shell-model';
import { cn } from '@/lib/cn';
import { eyebrowClass } from './design-system';
import { MARK_VIEW_BOX, presentLoader, type LoaderSize } from './loading-presentation';

/**
 * The brand mark, playing. Every wait in the app is one of these — bare inside
 * a control that already names itself, or wrapped by one of the surfaces below
 * when the wait needs its own words.
 *
 * Decorative on its own: the surfaces own the announcement.
 */
export function LiedmotifLoader({ size = 'sm' }: { size?: LoaderSize }) {
  const { pixels, bars, glow, badgePixels } = presentLoader(size);
  const mark = (
    <svg
      width={pixels}
      height={pixels}
      viewBox={MARK_VIEW_BOX}
      aria-hidden
      className={cn('shrink-0', glow && 'liedmotif-loader-glow')}
    >
      {bars.map((bar) => (
        <rect
          key={bar.toneClass}
          className={cn('liedmotif-loader-bar', bar.toneClass)}
          x={bar.x}
          y={bar.y}
          width={bar.width}
          height={bar.height}
          rx={bar.rx}
          fill="currentColor"
          style={{ animationDelay: `${bar.delaySeconds}s` }}
        />
      ))}
    </svg>
  );

  if (badgePixels == null) return mark;
  return (
    <span
      className="grid shrink-0 place-items-center rounded-full border border-line [background:var(--gradient-card)] shadow-[var(--shadow-float)]"
      style={{ width: badgePixels, height: badgePixels }}
    >
      {mark}
    </span>
  );
}

/**
 * A wait inside a list or sheet. `role="status"` belongs to the primitive so no
 * surface can render this look without announcing it.
 *
 * `className` carries only spacing — `cn` is a plain join with no
 * Tailwind-merge, so anything that collides with the base classes would resolve
 * by stylesheet order rather than by argument order.
 */
export function LoadingRow({ label, className }: { label: string; className?: string }) {
  return (
    <p
      role="status"
      aria-live="polite"
      className={cn('flex items-center justify-center gap-2 text-[13px] text-muted', className)}
    >
      <LiedmotifLoader />
      {label}
    </p>
  );
}

/**
 * A wait that owns the whole frame, named by the same identity the app chrome
 * gives that route. The bars already say "loading", so the eyebrow only has to
 * name the destination; the hidden line carries the whole announcement, so the
 * destination is never spoken twice.
 *
 * Fixed to the viewport so the mark sits at the true vertical center of the
 * page regardless of the route chrome; `left` starts past the desktop nav rail
 * so the horizontal center matches the content region (`--rail` is 0 on mobile).
 */
export function LoadingScreen({ pathname }: { pathname: string }) {
  const destination = getPageIdentity(pathname);
  return (
    <div
      role="status"
      aria-live="polite"
      className="liedmotif-loader-in fixed inset-y-0 right-0 left-(--rail) flex flex-col items-center justify-center gap-4"
    >
      <LiedmotifLoader size="lg" />
      <p aria-hidden className={eyebrowClass}>
        {destination}
      </p>
      <span className="sr-only">Loading {destination}…</span>
    </div>
  );
}
