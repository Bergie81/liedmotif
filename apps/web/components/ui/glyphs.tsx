// Liedmotif's own icons, drawn on Lucide's grid (24-unit box, 2-unit round
// stroke) so they sit beside Lucide icons as one family.

import type { ReactNode } from 'react';

type GlyphProps = { className?: string };

function Glyph({ className, children }: GlyphProps & { children: ReactNode }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {children}
    </svg>
  );
}

/** A Session: a vinyl record. Its label ring keeps it apart from the plain
 *  disc that stands in for a missing cover. */
export function SessionGlyph({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="3" />
      <path d="M12 12h.01" />
      <path d="M9.61 5.42A7 7 0 0 0 5.42 9.61" />
      <path d="M14.39 18.58A7 7 0 0 0 18.58 14.39" />
    </Glyph>
  );
}

/** Change Vibe: a tuning knob turned to a new station. */
export function ChangeVibeGlyph({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <circle cx="12" cy="14.5" r="4.5" />
      <path d="M12 14.5l2.3-2.3" />
      <path d="M4.21 10A9 9 0 0 1 18.89 8.71" />
      <path d="M19.11 6.22 18.89 8.71 16.4 8.49" />
    </Glyph>
  );
}

/** Loop a Part: the end of a marked stretch jumps back to its start. */
export function SectionLoopGlyph({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M4 5v14" />
      <path d="M20 5v14" />
      <path d="M16 12H8" />
      <path d="m11 9-3 3 3 3" />
    </Glyph>
  );
}

/** More Like This: the playing wave carries on while a new one branches off. */
export function MoreLikeThisGlyph({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <path d="M2 15c2.5-2 4-2 6.5 0s4 2 6.5 0 4-2 6.5 0" />
      <path d="M8.5 15C9 9.5 14 6 21 6" />
      <path d="m18 3 3 3-3 3" />
    </Glyph>
  );
}

/** The Assistant: a crew radio whose signal is the sparkle that marks AI. */
export function AssistantGlyph({ className }: GlyphProps) {
  return (
    <Glyph className={className}>
      <rect x="3" y="8.5" width="9" height="13" rx="2" />
      <path d="M5.5 8.5V2.5" />
      <path d="M6 12.5h3" />
      <path d="M6 15.5h3" />
      <path d="M7.5 18.5h.01" />
      <path
        d="M18.5 0.75Q19.6 4.65 23.5 5.75Q19.6 6.85 18.5 10.75Q17.4 6.85 13.5 5.75Q17.4 4.65 18.5 0.75z"
        fill="currentColor"
        strokeWidth={1}
      />
      <path
        d="M17.5 14.5Q18.05 16.45 20 17Q18.05 17.55 17.5 19.5Q16.95 17.55 15 17Q16.95 16.45 17.5 14.5z"
        fill="currentColor"
        strokeWidth={1}
      />
    </Glyph>
  );
}

/** The branching wave leaves more empty space in its box than a Lucide icon
 *  does, so in a menu row it draws larger than the 18px slot, and the negative
 *  margin keeps the label aligned with the other rows. */
export function MenuMoreLikeThisGlyph() {
  return <MoreLikeThisGlyph className="-m-0.5 h-[22px]! w-[22px]!" />;
}
