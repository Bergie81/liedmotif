import type { LibraryTab } from './use-library-query';

/** What a Library tab is called, wherever it is named. Total by type, so a new
 *  tab cannot ship without one. */
const TAB_LABELS: Record<LibraryTab, string> = {
  playlists: 'Playlists',
  favorites: 'Favorites',
  saved: 'Saved',
  history: 'History',
};

/** The order the strip shows them in. */
const TAB_ORDER: LibraryTab[] = ['playlists', 'favorites', 'saved', 'history'];

export function libraryTabLabel(tab: LibraryTab): string {
  return TAB_LABELS[tab];
}

export function LibraryNavigation({
  view,
  currentCount,
  hasMore,
  disabled = false,
  onChange,
}: {
  view: LibraryTab;
  /** null = not yet known — the badge stays hidden rather than showing 0. */
  currentCount: number | null;
  hasMore: boolean;
  disabled?: boolean;
  onChange: (view: LibraryTab) => void;
}) {
  return (
    <>
      {/* The hairline sits on this non-scrolling wrapper and the scroller
          overlaps it by 1px, so the active tab's 2px underline covers it
          while the scroller's children never overflow vertically — a tab
          strip must never grow a vertical scrollbar. */}
      <div className="mt-4 border-b border-line">
        <div className="-mb-px flex gap-[2px] overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          {TAB_ORDER.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => onChange(tab)}
              disabled={disabled}
              aria-pressed={view === tab}
              className="whitespace-nowrap border-b-2 border-b-transparent px-4 py-3 text-[14px] font-semibold text-dim aria-pressed:border-b-lamp aria-pressed:text-lamp disabled:cursor-wait"
            >
              {libraryTabLabel(tab)}
              {view === tab && currentCount !== null ? (
                // Zero-width so an arriving count never widens the tab and
                // shifts its neighbors; the digits spill into the tab's own
                // right padding instead.
                <span className="inline-block w-0 overflow-visible">
                  <span className="pl-1 font-mono text-[10px] font-normal text-dim">
                    {currentCount}
                    {hasMore ? '+' : ''}
                  </span>
                </span>
              ) : null}
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
