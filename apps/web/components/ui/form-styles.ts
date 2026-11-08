// Shared Tailwind class strings for form controls, so inputs look consistent
// across the login, setup, and settings forms.

export const inputClass =
  'w-full rounded-xl border border-line-2 bg-[var(--field-bg)] shadow-[var(--shadow-field)] px-4 py-3 text-[15px] text-paper placeholder:text-dim light:focus:bg-panel focus:border-lamp/60 focus:shadow-[0_0_0_3px_var(--lamp-glow)]';

export const labelClass = 'flex flex-col gap-2 text-[13px] font-semibold text-paper';

// `liedmotif-ink-loader`: this button paints itself with the brand, so the
// loading mark's own amber bar would vanish into it. The class hands the mark
// the button's ink instead — carried by the button so no call site has to
// remember it.
const primaryButtonBaseClass =
  'liedmotif-ink-loader inline-flex items-center justify-center gap-2 [background:var(--gradient-primary)] font-semibold text-[var(--on-lamp)] shadow-[var(--shadow-primary)] [transition:transform_.06s_ease,box-shadow_.15s_ease,filter_.15s_ease] active:scale-[0.985] disabled:cursor-not-allowed disabled:grayscale-[0.7] disabled:brightness-[0.6] disabled:shadow-none';

export const primaryButtonClass = `${primaryButtonBaseClass} rounded-[13px] px-5 py-3 text-[15px]`;
export const compactPrimaryButtonClass = `${primaryButtonBaseClass} rounded-[10px] px-4 py-2 text-[13.5px]`;
/** The primary button as a lone glyph, sized like the transport's satellites. */
export const roundPrimaryButtonClass = `${primaryButtonBaseClass} h-[52px] w-[52px] rounded-full`;

export const secondaryButtonBaseClass =
  'inline-flex items-center justify-center gap-2 border border-line-2 bg-[var(--control-bg)] shadow-[var(--shadow-control)] font-semibold text-paper [transition:transform_.06s_ease,background_.15s_ease] hover:bg-[var(--control-bg-hover)] active:scale-[0.985] disabled:cursor-not-allowed disabled:opacity-50';

export const secondaryButtonClass = `${secondaryButtonBaseClass} rounded-[10px] px-4 py-2 text-[13.5px]`;
/** The neutral button at `primaryButtonClass`'s size. */
export const largeSecondaryButtonClass = `${secondaryButtonBaseClass} rounded-[13px] px-5 py-3 text-[15px]`;
