// The instance's limit-reset timezone: the one list every surface offers, and the
// one validator every write goes through.
//
// `resetTimezone` decides when the daily and monthly Track windows roll over
// (`limitWindowStarts`), so a wrong value moves the owner's budget boundary rather
// than merely mislabelling it. Zones come from the runtime's own IANA database, so
// the list cannot drift from what `Intl` will actually accept.

let cachedZones: string[] | null = null;

/**
 * Every zone this runtime accepts, `UTC` first, then alphabetical. Built once: the
 * IANA database cannot change while the process or tab lives, and this list is ~400
 * entries that every Select would otherwise re-sort on each render.
 */
export function supportedTimezones(): string[] {
  cachedZones ??= [
    'UTC',
    ...Intl.supportedValuesOf('timeZone')
      .filter((zone) => zone !== 'UTC')
      .sort((a, b) => a.localeCompare(b)),
  ];
  return cachedZones;
}

/**
 * Whether a stored or submitted zone is one `Intl` can actually format in. A bare
 * offset (`+05:00`) is refused although `Intl` accepts it: Postgres reads the same
 * string as a POSIX zone, west of UTC, so backups and stats would roll over on the
 * opposite side of UTC from the limit windows.
 */
export function isSupportedTimezone(zone: string): boolean {
  if (!zone.trim() || /^[+-]/.test(zone.trim())) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface TimezoneGroup {
  /** The IANA area (`Europe`, `America`, …); `UTC` has none of its own. */
  area: string;
  zones: string[];
}

/**
 * The zones grouped by IANA area, so a 400-entry list is scannable. `UTC` leads its
 * own group because it is the shipped default and the one answer that is never
 * geographic.
 */
export function timezoneGroups(zones = supportedTimezones()): TimezoneGroup[] {
  const groups = new Map<string, string[]>();
  for (const zone of zones) {
    const [area = zone] = zone.split('/');
    const existing = groups.get(area);
    if (existing) existing.push(zone);
    else groups.set(area, [zone]);
  }
  return [...groups].map(([area, areaZones]) => ({ area, zones: areaZones }));
}

/** The part of a zone worth reading once its area is the group heading. */
export function timezoneLabel(zone: string): string {
  const withoutArea = zone.includes('/') ? zone.slice(zone.indexOf('/') + 1) : zone;
  return withoutArea.replaceAll('_', ' ').replaceAll('/', ' — ');
}

/**
 * The browser's own zone, or `UTC` when it cannot be read. Used to preselect the
 * control rather than to decide anything — the owner still confirms it.
 */
export function detectTimezone(): string {
  const detected = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return detected && isSupportedTimezone(detected) ? detected : 'UTC';
}
