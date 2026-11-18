'use client';

// Who may ask the Assistant, and how often: the instance default every Member
// follows, and one Member's own switch and daily allowance on their card. A
// change saves as it is made; the screen shows it at once and takes it back if
// the save fails.

import { useId, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type {
  AssistantAccess,
  MemberAssistantAccess,
  UpdateAssistantAccessRequest,
  UpdateMemberAssistantAccessRequest,
} from '@liedmotif/shared';
import { Switch } from '@/components/ui/controls';
import { apiFetchJson } from '@/lib/api-fetch';
import { toast } from '@/lib/toast';
import { SettingsCard, SettingsControlRow, SettingsFootnote } from '../settings-ui';
import {
  memberAssistantView,
  parseDailyMessages,
  type AccessSource,
} from './assistant-access-model';
import { budgetNumberInputClass } from './member-budget-fields';

/**
 * A stored value the screen edits in place. `stored` is what the server
 * rendered; a save shows its outcome first and lands on what the route
 * answered, or goes back and reports why.
 */
function useSavedAccess<T, P>(stored: T, url: string, preview: (current: T, patch: P) => T) {
  const router = useRouter();
  const [value, setValue] = useState(stored);
  const [seenStored, setSeenStored] = useState(stored);
  const [busy, setBusy] = useState(false);
  if (seenStored !== stored) {
    setSeenStored(stored);
    setValue(stored);
  }

  async function save(patch: P) {
    if (busy) return;
    const before = value;
    setBusy(true);
    toast.dismiss(url);
    setValue(preview(before, patch));
    const result = await apiFetchJson<{ access: T }>(url, 'POST', patch);
    setBusy(false);
    if (!result.ok) {
      setValue(before);
      toast.error(result.message, { key: url });
      return;
    }
    setValue(result.data.access);
    // The default reaches every Member card through the page's own data.
    router.refresh();
  }

  return { value, busy, save };
}

/** A typed daily allowance, saved when the field is left or Enter is pressed. */
function DailyMessagesRow({
  name,
  value,
  note,
  disabled,
  onCommit,
}: {
  /** The field's accessible name. */
  name: string;
  value: number;
  note: ReactNode;
  disabled: boolean;
  onCommit: (dailyMessages: number) => void;
}) {
  const noteId = useId();
  const [draft, setDraft] = useState(String(value));
  const [seenValue, setSeenValue] = useState(value);
  const [error, setError] = useState<string | null>(null);
  if (seenValue !== value) {
    setSeenValue(value);
    setDraft(String(value));
    setError(null);
  }

  function commit() {
    const parsed = parseDailyMessages(draft);
    if ('error' in parsed) {
      setError(parsed.error);
      return;
    }
    setError(null);
    setDraft(String(parsed.value));
    if (parsed.value !== value) onCommit(parsed.value);
  }

  return (
    <SettingsControlRow
      label="Messages per day"
      description={error ? <span className="text-warn">{error}</span> : note}
      descriptionId={noteId}
    >
      <input
        type="text"
        inputMode="numeric"
        enterKeyHint="done"
        aria-label={name}
        aria-describedby={noteId}
        aria-invalid={error ? true : undefined}
        value={draft}
        maxLength={4}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') event.currentTarget.blur();
        }}
        className={budgetNumberInputClass}
      />
    </SettingsControlRow>
  );
}

/**
 * The instance default. `access` is null while no Text AI is connected:
 * there is no Assistant to give access to, so the controls give way to a hint.
 */
export function AssistantDefaultPanel({ access }: { access: AssistantAccess | null }) {
  if (!access) {
    return (
      <SettingsCard>
        <p className="text-[13px] leading-relaxed text-muted">
          The Assistant runs on your Text AI, and none is connected. Add one under{' '}
          <Link href="/settings/providers" className="text-paper underline underline-offset-2">
            Settings → AI Providers
          </Link>{' '}
          to choose who may use it.
        </p>
      </SettingsCard>
    );
  }
  return <AssistantDefaultControls access={access} />;
}

function AssistantDefaultControls({ access }: { access: AssistantAccess }) {
  const { value, busy, save } = useSavedAccess(
    access,
    '/api/settings/members/assistant',
    (current: AssistantAccess, patch: UpdateAssistantAccessRequest) => ({ ...current, ...patch }),
  );
  return (
    <SettingsCard>
      <SettingsControlRow
        label="Assistant for Members"
        description="Members can ask the Assistant about your Liedmotif"
      >
        <Switch
          checked={value.enabled}
          onCheckedChange={(enabled) => void save({ enabled })}
          disabled={busy}
          aria-label="Assistant for Members"
        />
      </SettingsControlRow>
      <DailyMessagesRow
        name="Messages per day"
        value={value.dailyMessages}
        note="What each Member may ask in a day"
        disabled={busy}
        onCommit={(dailyMessages) => void save({ dailyMessages })}
      />
      <SettingsFootnote>
        The default for every Member; set one Member&apos;s own on their card. Your own questions
        have no daily allowance.
      </SettingsFootnote>
    </SettingsCard>
  );
}

/** Where a Member's value comes from, with the way back to the default beside an own one. */
function SourceNote({
  source,
  subject,
  disabled,
  onUseDefault,
}: {
  source: AccessSource;
  /** What the value is, for the button's accessible name. */
  subject: string;
  disabled: boolean;
  onUseDefault: () => void;
}) {
  if (source === 'default') return 'Default';
  return (
    <>
      Set for this Member ·{' '}
      <button
        type="button"
        onClick={onUseDefault}
        disabled={disabled}
        aria-label={`Use default for ${subject}`}
        className="text-paper underline underline-offset-2 disabled:opacity-35"
      >
        Use default
      </button>
    </>
  );
}

function previewMemberAccess(
  current: MemberAssistantAccess,
  patch: UpdateMemberAssistantAccessRequest,
): MemberAssistantAccess {
  const next: MemberAssistantAccess = { ...current };
  if (patch.enabled === null) delete next.enabled;
  else if (patch.enabled !== undefined) next.enabled = patch.enabled;
  if (patch.dailyMessages === null) delete next.dailyMessages;
  else if (patch.dailyMessages !== undefined) next.dailyMessages = patch.dailyMessages;
  return next;
}

/** One Member's switch and daily allowance, each marked as the default or their own. */
export function MemberAssistantControls({
  memberUserId,
  memberName,
  instanceDefault,
  own,
}: {
  memberUserId: string;
  memberName: string;
  instanceDefault: AssistantAccess;
  /** The values the Admin set for this Member; an absent field follows the default. */
  own: MemberAssistantAccess;
}) {
  const switchNoteId = useId();
  const { value, busy, save } = useSavedAccess(
    own,
    `/api/settings/members/${memberUserId}/assistant`,
    previewMemberAccess,
  );
  const view = memberAssistantView(instanceDefault, value);
  const who = memberName || 'this Member';
  return (
    <div className="mt-2 border-t border-line">
      <SettingsControlRow
        label="Assistant"
        description={
          <SourceNote
            source={view.enabled.source}
            subject="Assistant"
            disabled={busy}
            onUseDefault={() => void save({ enabled: null })}
          />
        }
        descriptionId={switchNoteId}
      >
        <Switch
          checked={view.enabled.value}
          onCheckedChange={(enabled) => void save({ enabled })}
          disabled={busy}
          aria-label={`Assistant for ${who}`}
          aria-describedby={switchNoteId}
        />
      </SettingsControlRow>
      <DailyMessagesRow
        name={`Messages per day for ${who}`}
        value={view.dailyMessages.value}
        note={
          <SourceNote
            source={view.dailyMessages.source}
            subject="Messages per day"
            disabled={busy}
            onUseDefault={() => void save({ dailyMessages: null })}
          />
        }
        disabled={busy}
        onCommit={(dailyMessages) => void save({ dailyMessages })}
      />
    </div>
  );
}
