// Label/value rows for diagnostics cards. No 'use client' on purpose: the
// server-rendered Instance card and the live client Worker card share it.
// Values carry `suppressHydrationWarning` because the live card renders
// relative times — the client recomputes them right after mount.

export type DefinitionRowTone = 'ok' | 'warn' | 'muted';

export interface DefinitionRow {
  label: string;
  value: string;
  tone: DefinitionRowTone;
}

function valueToneClass(tone: DefinitionRowTone, value: string): string {
  switch (tone) {
    case 'ok':
      return 'text-signal';
    case 'warn':
      return 'text-warn';
    case 'muted':
      // A reading the instance could not produce recedes further than a real one.
      return value === 'Unavailable' ? 'text-dim' : 'text-muted';
  }
}

export function DefinitionRows({ rows }: { rows: DefinitionRow[] }) {
  return (
    <dl>
      {rows.map(({ label, value, tone }) => (
        <div
          key={label}
          className="flex items-baseline justify-between gap-4 border-b border-line py-2 last:border-b-0"
        >
          <dt className="text-[13.5px] font-semibold">{label}</dt>
          <dd
            suppressHydrationWarning
            className={`min-w-0 truncate text-right font-mono text-[11px] uppercase tracking-[0.05em] ${valueToneClass(tone, value)}`}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
