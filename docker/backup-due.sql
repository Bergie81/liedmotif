-- When is a backup due? The backup sidecar (docker/backup.sh) runs this once a
-- minute and decides from the one row it returns:
--
--   psql -X -A -t -F '|' -v ON_ERROR_STOP=1 -v now=<ISO timestamp> -f backup-due.sql
--
-- Columns, in this order:
--   enabled | frequency | weekday | hour | keep | include_media | timezone
--   | requested_at | last_slot | next_slot
--
-- `now` is a parameter rather than now() so a test can run
-- this exact file at pinned instants.
--
-- An absent `backupSchedule` key or field reads as the shipped default; these
-- literals repeat DEFAULT_BACKUP_SCHEDULE (@liedmotif/shared) and must stay
-- equal to it. The timezone is the instance timezone,
-- `usageLimits.resetTimezone`, else UTC.
--
-- Timestamps come out as UTC `YYYY-MM-DDTHH:MM:SSZ`, the format
-- `date -u +%Y-%m-%dT%H:%M:%SZ` writes, so the sidecar can compare them as
-- strings. `requested_at` is rounded UP to the second: against an attempt that
-- started on a whole second, "the request is later" then answers exactly as
-- the stored millisecond timestamp would. A request later than `now` reads as
-- empty: the sidecar stamps an attempt it starts with `now`, and that request,
-- rounded up, would still be later than the attempt and run a second time.
-- The next minute's check picks it up instead.
--
-- `last_slot` is the latest scheduled slot at or before `now`, `next_slot` the
-- one after it. Both are found in local wall time and only then converted
-- with AT TIME ZONE, so a 03:00 slot stays 03:00 local across DST changes.

with
  stored as (
    select
      (select value from app_settings where key = 'backupSchedule') as schedule,
      (select value from app_settings where key = 'backupRequest') as request,
      (select value from app_settings where key = 'usageLimits') as limits
  ),
  effective as (
    select
      :'now'::timestamptz as now,
      coalesce((schedule ->> 'enabled')::boolean, true) as enabled,
      coalesce(schedule ->> 'frequency', 'weekly') as frequency,
      coalesce((schedule ->> 'weekday')::int, 0) as weekday,
      coalesce((schedule ->> 'hour')::int, 3) as hour,
      coalesce((schedule ->> 'keep')::int, 4) as keep,
      coalesce((schedule ->> 'includeMedia')::boolean, true) as include_media,
      coalesce(limits ->> 'resetTimezone', 'UTC') as timezone,
      (request ->> 'requestedAt')::timestamptz as requested_at
    from stored
  ),
  this_period as (
    select
      effective.*,
      case when frequency = 'daily' then interval '1 day' else interval '7 days' end as period,
      -- This period's slot in local wall time: today's for daily, this week's
      -- `weekday` (0 = Sunday, like `dow`) for weekly. It may still be ahead
      -- of `now` when it falls on today.
      date_trunc('day', now at time zone timezone)
        + make_interval(hours => hour)
        - case
          when frequency = 'daily' then interval '0'
          else make_interval(days => (extract(dow from now at time zone timezone)::int - weekday + 7) % 7)
        end
        as slot_local
    from effective
  ),
  slots as (
    select
      this_period.*,
      case
        when (slot_local at time zone timezone) <= now then slot_local
        else slot_local - period
      end as last_slot_local
    from this_period
  )
select
  enabled,
  frequency,
  weekday,
  hour,
  keep,
  include_media,
  timezone,
  case
    when requested_at <= now then
      to_char(
        to_timestamp(ceil(extract(epoch from requested_at))) at time zone 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS"Z"'
      )
  end as requested_at,
  to_char(
    (last_slot_local at time zone timezone) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ) as last_slot,
  to_char(
    ((last_slot_local + period) at time zone timezone) at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS"Z"'
  ) as next_slot
from slots;
