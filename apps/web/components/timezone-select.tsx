'use client';

// The ONE Select every timezone surface renders (first-login onboarding's profile
// step and Settings → Generation), so the zone list and its grouping can never drift
// between them. Callers own their surrounding label markup.

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  isSupportedTimezone,
  supportedTimezones,
  timezoneGroups,
  timezoneLabel,
} from '@/lib/timezones';

export function TimezoneSelect({
  value,
  onChange,
  ariaLabel,
  disabled,
  triggerClassName,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  triggerClassName?: string;
}) {
  // A stored zone `Intl` accepts but does not list (`Etc/UTC`, an alias such as
  // `US/Eastern` or `Asia/Kolkata`) must still be an item, or the trigger shows blank.
  const listed = supportedTimezones();
  const zones = listed.includes(value) || !isSupportedTimezone(value) ? listed : [...listed, value];
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} className={triggerClassName}>
        <SelectValue />
      </SelectTrigger>
      {/* The menu opens as wide as the field it belongs to. A minimum rather than a
          fixed width, because a caller may cap its trigger (Settings → Cost controls
          does) and a zone label must not be squeezed to fit that cap. */}
      <SelectContent className="min-w-[var(--radix-select-trigger-width)]">
        {timezoneGroups(zones).map((group) => (
          <SelectGroup key={group.area}>
            {group.area === 'UTC' ? null : <SelectLabel>{group.area}</SelectLabel>}
            {group.zones.map((zone) => (
              <SelectItem key={zone} value={zone}>
                {timezoneLabel(zone)}
              </SelectItem>
            ))}
          </SelectGroup>
        ))}
      </SelectContent>
    </Select>
  );
}
