'use client';

// Settings → Backups, the live part: the sidecar's status, the schedule form,
// Back up now and the backup list. The server renders the first overview; the
// page then follows a requested or running backup closely and otherwise
// refreshes when it regains focus.

import { useCallback, useEffect, useId, useState } from 'react';
import Link from 'next/link';
import { Download } from 'lucide-react';
import {
  BACKUP_FREQUENCIES,
  BACKUP_KEEP_MAX,
  BACKUP_KEEP_MIN,
  type BackupFrequency,
  type BackupSchedule,
  type BackupsOverview,
} from '@liedmotif/shared';
import { DefinitionRows } from '@/components/settings/definition-rows';
import { Stepper, Switch } from '@/components/ui/controls';
import { segmentedListClass, segmentedTriggerClass } from '@/components/ui/design-system';
import {
  primaryButtonClass,
  secondaryButtonClass,
  largeSecondaryButtonClass,
} from '@/components/ui/form-styles';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { apiFetch, apiFetchJson } from '@/lib/api-fetch';
import { cn } from '@/lib/cn';
import { formatBinaryBytes } from '@/lib/format-bytes';
import {
  BACKUP_HOUR_OPTIONS,
  backUpNowButton,
  backupListMeta,
  backupsPollMs,
  backupStatusSummary,
  backupsUnencrypted,
  formatBackupTime,
} from './backups-form-model';
import {
  SettingsCard,
  SettingsControlRow,
  SettingsFeedback,
  SettingsFootnote,
  SettingsSection,
  SettingsStatusBadge,
  type SettingsFeedbackState,
} from './settings-ui';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const FREQUENCY_LABELS: Record<BackupFrequency, string> = { daily: 'Daily', weekly: 'Weekly' };

export function BackupsPanel({ initial }: { initial: BackupsOverview }) {
  const [overview, setOverview] = useState(initial);
  const [schedule, setSchedule] = useState(initial.schedule);
  const [saving, setSaving] = useState(false);
  const [scheduleFeedback, setScheduleFeedback] = useState<SettingsFeedbackState>(null);
  const [requesting, setRequesting] = useState(false);
  const [requestFeedback, setRequestFeedback] = useState<SettingsFeedbackState>(null);
  const downloadReasonId = useId();

  const refresh = useCallback(async (signal?: AbortSignal): Promise<BackupsOverview | null> => {
    const result = await apiFetch<BackupsOverview>('/api/settings/backups', {
      signal,
      cache: 'no-store',
    });
    if (!result.ok || signal?.aborted) return null;
    setOverview(result.data);
    return result.data;
  }, []);

  const pollMs = backupsPollMs(overview.service);
  useEffect(() => {
    const controller = new AbortController();
    const refreshVisible = () => {
      if (!document.hidden) void refresh(controller.signal);
    };
    const timer = pollMs === null ? null : setInterval(refreshVisible, pollMs);
    window.addEventListener('focus', refreshVisible);
    document.addEventListener('visibilitychange', refreshVisible);
    return () => {
      controller.abort();
      if (timer !== null) clearInterval(timer);
      window.removeEventListener('focus', refreshVisible);
      document.removeEventListener('visibilitychange', refreshVisible);
    };
  }, [pollMs, refresh]);

  function change<K extends keyof BackupSchedule>(field: K, value: BackupSchedule[K]) {
    setSchedule((current) => ({ ...current, [field]: value }));
  }

  async function save() {
    if (saving) return;
    setScheduleFeedback(null);
    setSaving(true);
    const result = await apiFetchJson<{ schedule: BackupSchedule }>(
      '/api/settings/backups',
      'PUT',
      schedule,
    );
    setSaving(false);
    if (result.ok) {
      setSchedule(result.data.schedule);
      void refresh();
    }
    setScheduleFeedback(
      result.ok
        ? { kind: 'success', message: 'Backup schedule saved.' }
        : { kind: 'error', message: result.message },
    );
  }

  async function backUpNow() {
    setRequestFeedback(null);
    setRequesting(true);
    const result = await apiFetch('/api/settings/backups/run', { method: 'POST' });
    // A refused request (a run already in progress) refreshes too, so the page shows that run.
    const current = (await refresh()) ?? overview;
    setRequesting(false);
    if (!result.ok) setRequestFeedback({ kind: 'error', message: result.message });
    else if (current.service === 'not-running') {
      setRequestFeedback({
        kind: 'info',
        message: 'Backup requested. It runs once the backup service is back.',
      });
    }
  }

  const tz = overview.timezone;
  const report = overview.status;
  const summary = backupStatusSummary(overview);
  const button = backUpNowButton({ service: overview.service, submitting: requesting });

  return (
    // Phones read Status, Schedule, Backups; desktop puts Schedule above the
    // Backups list on the left, with Status beside them.
    <div className="mt-6 @container">
      <div className="@split:grid @split:grid-cols-2 @split:items-start @split:gap-x-12">
        <div className="@split:col-start-2 @split:row-span-2 @split:row-start-1">
          <SettingsSection title="Status">
            <SettingsCard>
              <div className="mb-1 flex items-center justify-between gap-3">
                <span className="text-[15px] font-semibold">Backup service</span>
                <SettingsStatusBadge status={summary.status} />
              </div>
              <p
                suppressHydrationWarning
                className={cn(
                  'mb-2 text-[12.5px]',
                  summary.status.tone === 'warn' ? 'text-warn' : 'text-dim',
                )}
              >
                {summary.detail}
              </p>
              <DefinitionRows
                rows={[
                  {
                    label: 'Last success',
                    value: !report
                      ? 'Unavailable'
                      : report.lastSuccessAt
                        ? formatBackupTime(report.lastSuccessAt, tz)
                        : 'Never',
                    tone: 'muted',
                  },
                  {
                    label: 'Next run',
                    value: !report
                      ? 'Unavailable'
                      : report.nextRunAt
                        ? formatBackupTime(report.nextRunAt, tz)
                        : 'Off',
                    tone: 'muted',
                  },
                  {
                    label: 'Disk used',
                    value: report ? formatBinaryBytes(report.diskBytes) : 'Unavailable',
                    tone: 'muted',
                  },
                  {
                    label: 'Free space',
                    value: report ? formatBinaryBytes(report.freeBytes) : 'Unavailable',
                    tone: 'muted',
                  },
                ]}
              />
              {backupsUnencrypted(overview) ? (
                <div className="mt-3">
                  <SettingsFeedback kind="error">
                    Unencrypted: database dumps, with every account, email and prompt, are written
                    in the clear. Set BACKUP_ENCRYPTION_PASSPHRASE in .env.
                  </SettingsFeedback>
                </div>
              ) : null}
            </SettingsCard>
            {requestFeedback ? (
              <div className="mt-4">
                <SettingsFeedback kind={requestFeedback.kind}>
                  {requestFeedback.message}
                </SettingsFeedback>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => void backUpNow()}
              disabled={button.disabled}
              className={`${largeSecondaryButtonClass} mt-4 w-full`}
            >
              {button.label}
            </button>
          </SettingsSection>
        </div>
        <div className="@split:col-start-1 @split:row-start-1">
          <SettingsSection title="Schedule">
            <SettingsCard>
              <SettingsControlRow
                label="Scheduled backups"
                description="When off, backups run only from Back up now"
              >
                <Switch
                  checked={schedule.enabled}
                  onCheckedChange={(checked) => change('enabled', checked)}
                  disabled={saving}
                  aria-label="Scheduled backups"
                />
              </SettingsControlRow>
              <div className={cn(!schedule.enabled && 'opacity-45')}>
                <div className="border-b border-line py-3">
                  <div className={segmentedListClass} role="group" aria-label="How often">
                    {BACKUP_FREQUENCIES.map((frequency) => {
                      const active = schedule.frequency === frequency;
                      return (
                        <button
                          key={frequency}
                          type="button"
                          data-state={active ? 'active' : 'inactive'}
                          aria-pressed={active}
                          disabled={saving || !schedule.enabled}
                          onClick={() => change('frequency', frequency)}
                          className={segmentedTriggerClass}
                        >
                          {FREQUENCY_LABELS[frequency]}
                        </button>
                      );
                    })}
                  </div>
                </div>
                {schedule.frequency === 'weekly' ? (
                  <SettingsControlRow label="Day">
                    <Select
                      value={String(schedule.weekday)}
                      onValueChange={(value) => change('weekday', Number(value))}
                      disabled={saving || !schedule.enabled}
                    >
                      <SelectTrigger aria-label="Backup day" className="w-[150px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WEEKDAYS.map((label, weekday) => (
                          <SelectItem key={label} value={String(weekday)}>
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </SettingsControlRow>
                ) : null}
                <SettingsControlRow label="Time">
                  <Select
                    value={String(schedule.hour)}
                    onValueChange={(value) => change('hour', Number(value))}
                    disabled={saving || !schedule.enabled}
                  >
                    <SelectTrigger aria-label="Backup time" className="w-[150px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {BACKUP_HOUR_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={String(option.value)}>
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsControlRow>
              </div>
              <SettingsControlRow
                label="Instance timezone"
                description="Also sets when limits reset"
              >
                <span className="flex flex-col items-end gap-[2px]">
                  <span className="font-mono text-[11px] uppercase tracking-[0.05em] text-muted">
                    {tz}
                  </span>
                  <Link
                    href="/settings/limits"
                    className="font-mono text-[10.5px] uppercase tracking-[0.05em] text-lamp hover:text-paper"
                  >
                    Change in Limits
                  </Link>
                </span>
              </SettingsControlRow>
              <SettingsControlRow
                label="Keep"
                description="Older backups are deleted after a new one"
              >
                <Stepper
                  value={schedule.keep}
                  onDecrement={() => change('keep', schedule.keep - 1)}
                  onIncrement={() => change('keep', schedule.keep + 1)}
                  decrementLabel="Keep fewer backups"
                  incrementLabel="Keep more backups"
                  canDecrement={!saving && schedule.keep > BACKUP_KEEP_MIN}
                  canIncrement={!saving && schedule.keep < BACKUP_KEEP_MAX}
                />
              </SettingsControlRow>
              <SettingsControlRow
                label="Include music & covers"
                description="Unchanged files are shared between backups, so each one adds only what is new"
              >
                <Switch
                  checked={schedule.includeMedia}
                  onCheckedChange={(checked) => change('includeMedia', checked)}
                  disabled={saving}
                  aria-label="Include music & covers"
                />
              </SettingsControlRow>
            </SettingsCard>
            {scheduleFeedback ? (
              <div className="mt-4">
                <SettingsFeedback kind={scheduleFeedback.kind}>
                  {scheduleFeedback.message}
                </SettingsFeedback>
              </div>
            ) : null}
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving}
              className={`${primaryButtonClass} mt-4 w-full`}
            >
              {saving ? 'Saving…' : 'Save schedule'}
            </button>
          </SettingsSection>
        </div>

        <div className="@split:col-start-1 @split:row-start-2">
          <SettingsSection title="Backups">
            <SettingsCard className={overview.backups.length === 0 ? 'border-dashed' : undefined}>
              {overview.backups.length === 0 ? (
                <p className="py-3 text-center text-[13px] text-dim">No backups yet.</p>
              ) : (
                overview.backups.map((backup) => (
                  <div
                    key={backup.id}
                    className="flex items-center gap-3 border-b border-line py-3 last:border-b-0"
                  >
                    <div className="min-w-0 flex-1">
                      <div suppressHydrationWarning className="truncate text-[14px] font-semibold">
                        {formatBackupTime(backup.createdAt, tz)}
                      </div>
                      <div className="mt-[2px] truncate font-mono text-[10.5px] uppercase tracking-[0.05em] text-dim">
                        {backupListMeta(backup)}
                      </div>
                    </div>
                    {overview.downloadAvailable ? (
                      <a
                        href={`/api/settings/backups/${backup.id}/download`}
                        download
                        className={secondaryButtonClass}
                        aria-label={`Download the backup of ${formatBackupTime(backup.createdAt, tz)}`}
                      >
                        <Download className="h-4 w-4" aria-hidden />
                        Download
                      </a>
                    ) : (
                      <button
                        type="button"
                        disabled
                        aria-describedby={downloadReasonId}
                        className={secondaryButtonClass}
                      >
                        <Download className="h-4 w-4" aria-hidden />
                        Download
                      </button>
                    )}
                  </div>
                ))
              )}
            </SettingsCard>
            {overview.backups.length > 0 && !overview.downloadAvailable ? (
              <p id={downloadReasonId} className="mt-3 text-[12.5px] text-dim">
                Download is off: it is encrypted with BACKUP_ENCRYPTION_PASSPHRASE, and the web
                server has none set in .env.
              </p>
            ) : null}
            <SettingsFootnote>
              A backup holds every account&rsquo;s content: Tracks, covers, prompts and voice
              recordings. The download opens only with the passphrase.
            </SettingsFootnote>
            <SettingsFootnote>
              To clone this instance elsewhere, the new one needs the same
              CREDENTIAL_ENCRYPTION_KEY, APP_SECRET and BETTER_AUTH_SECRET, plus the backup
              passphrase.
            </SettingsFootnote>
          </SettingsSection>
        </div>
      </div>
    </div>
  );
}
