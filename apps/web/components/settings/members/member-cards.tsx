'use client';

// One card per Member: aggregates and usage meters (never content), their
// Assistant access, and the three account actions. Budget edits open inline and
// save through the same route enforcement reads back.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type {
  AssistantAccess,
  MemberResetPasswordResponse,
  PoolOverSubscription,
  UnitCosts,
} from '@liedmotif/shared';
import { apiFetch, apiFetchJson, type ApiFetchResult } from '@/lib/api-fetch';
import { formatBinaryBytes } from '@/lib/format-bytes';
import {
  compactPrimaryButtonClass,
  inputClass,
  secondaryButtonClass,
} from '@/components/ui/form-styles';
import type { MembersAdminData, MembersAdminMember } from '@/lib/members-admin-data';
import { toast } from '@/lib/toast';
import { BudgetUsageMeters, MEMBER_TRACK_LABELS } from '../budget-meters';
import { SettingsCard, SettingsFeedback, SettingsStatusBadge } from '../settings-ui';
import { MemberAssistantControls } from './assistant-access-controls';
import { CopyLinkBox } from './copy-link-box';
import { MemberBudgetKindFields } from './member-budget-fields';
import {
  budgetKindLabel,
  buildMemberBudgetKindPatch,
  memberBudgetFormValues,
  memberMetaLine,
  overSubscriptionMessage,
  resetFallbackLine,
} from './members-admin-model';
import { useMemberBudgetForm } from './use-member-budget-form';

/** A reset that came back as a link to copy, because it was not mailed. */
type MemberResetLink = Extract<MemberResetPasswordResponse, { url: string }>;

/** The reset link to copy, and why it was not mailed. */
function ResetLink({ reset }: { reset: MemberResetLink }) {
  const line = resetFallbackLine(reset.reason);
  return (
    <>
      {line ? (
        <div className="mt-3">
          <SettingsFeedback kind="info">{line}</SettingsFeedback>
        </div>
      ) : null}
      <CopyLinkBox url={reset.url} label="Password reset link" />
    </>
  );
}

function MemberCard({
  member,
  tracksPerCall,
  minHeadroomTracks,
  unitCosts,
  assistantDefault,
  timezone,
}: {
  member: MembersAdminMember;
  tracksPerCall: number;
  minHeadroomTracks: number;
  unitCosts: UnitCosts;
  assistantDefault: AssistantAccess | null;
  timezone: string;
}) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const { kind, setKind, values, setValues, errors, change, setErrors } = useMemberBudgetForm(
    () => memberBudgetFormValues(member.budget, tracksPerCall),
    member.budget.kind,
  );
  const [busy, setBusy] = useState<null | 'budget' | 'reset' | 'disable' | 'delete'>(null);
  const [resetLink, setResetLink] = useState<MemberResetLink | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmName, setConfirmName] = useState('');

  /** The shared action choreography: one action at a time, a failure as a toast its retry replaces. */
  async function run<T>(
    tag: NonNullable<typeof busy>,
    call: () => Promise<ApiFetchResult<T>>,
    onSuccess: (data: T) => void,
  ) {
    if (busy) return;
    const key = `member-${tag}:${member.userId}`;
    setBusy(tag);
    toast.dismiss(key);
    const result = await call();
    setBusy(null);
    if (!result.ok) {
      toast.error(result.message, { key });
      return;
    }
    onSuccess(result.data);
  }

  function cancelBudgetEdit() {
    setKind(member.budget.kind);
    setValues(memberBudgetFormValues(member.budget, tracksPerCall));
    setErrors({});
    setEditing(false);
  }

  async function saveBudget() {
    const parsed = buildMemberBudgetKindPatch(kind, values, tracksPerCall);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    await run(
      'budget',
      () =>
        apiFetchJson<{ overSubscription: PoolOverSubscription[] }>(
          `/api/settings/members/${member.userId}/limits`,
          'POST',
          parsed.patch,
        ),
      ({ overSubscription }) => {
        const warning = overSubscription[0];
        if (warning) toast.warning(`Saved. ${overSubscriptionMessage(warning, tracksPerCall)}`);
        else toast.success('Budget saved — it applies at the next generation.');
        setEditing(false);
        router.refresh();
      },
    );
  }

  const mintResetLink = () =>
    run(
      'reset',
      () =>
        apiFetch<MemberResetPasswordResponse>(
          `/api/settings/members/${member.userId}/reset-password`,
          { method: 'POST' },
        ),
      (reset) => {
        if ('url' in reset) {
          setResetLink(reset);
          return;
        }
        setResetLink(null);
        toast.success(`Reset mail sent to ${reset.to}. The link works for 1 hour.`);
      },
    );

  const destroy = () =>
    run(
      'delete',
      () => apiFetch(`/api/settings/members/${member.userId}`, { method: 'DELETE' }),
      () => router.refresh(),
    );

  const toggleDisabled = () =>
    run(
      'disable',
      () =>
        apiFetchJson(`/api/settings/members/${member.userId}/disabled`, 'POST', {
          disabled: !member.disabled,
        }),
      () => router.refresh(),
    );

  return (
    <SettingsCard className="mb-4 last:mb-0">
      <div className="flex flex-wrap items-center gap-2">
        <b className="text-[15px] font-semibold">{member.name || 'Unnamed'}</b>
        <SettingsStatusBadge
          status={{ label: `${budgetKindLabel(member.budget.kind)} budget`, tone: 'muted' }}
        />
        {member.disabled ? (
          <SettingsStatusBadge status={{ label: 'Disabled', tone: 'warn' }} />
        ) : null}
      </div>
      <p className="mt-1 font-mono text-[10.5px] uppercase tracking-[0.05em] text-dim">
        {memberMetaLine(member, timezone)}
      </p>

      <div className="mt-3">
        <BudgetUsageMeters
          usage={member.usage}
          trackLabels={MEMBER_TRACK_LABELS}
          unitCosts={unitCosts}
        />
      </div>

      {assistantDefault ? (
        <MemberAssistantControls
          memberUserId={member.userId}
          memberName={member.name}
          instanceDefault={assistantDefault}
          own={member.assistant}
        />
      ) : null}

      {editing ? (
        <div className="mt-2 border-t border-line pt-4">
          <MemberBudgetKindFields
            kind={kind}
            onKindChange={setKind}
            values={values}
            errors={errors}
            disabled={busy === 'budget'}
            tracksPerCall={tracksPerCall}
            minHeadroomTracks={minHeadroomTracks}
            unitCosts={unitCosts}
            onChange={change}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void saveBudget()}
              disabled={busy !== null}
              className={compactPrimaryButtonClass}
            >
              {busy === 'budget' ? 'Saving…' : 'Save budget'}
            </button>
            <button
              type="button"
              onClick={cancelBudgetEdit}
              disabled={busy !== null}
              className={secondaryButtonClass}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={busy !== null}
            className={secondaryButtonClass}
          >
            Edit budget
          </button>
          <button
            type="button"
            onClick={() => void mintResetLink()}
            disabled={busy !== null}
            className={secondaryButtonClass}
          >
            {busy === 'reset' ? 'Minting link…' : 'Reset password'}
          </button>
          <button
            type="button"
            onClick={() => void toggleDisabled()}
            disabled={busy !== null}
            className={secondaryButtonClass}
          >
            {busy === 'disable'
              ? 'Working…'
              : member.disabled
                ? 'Enable account'
                : 'Disable account'}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirmName('');
              setConfirmingDelete(true);
            }}
            disabled={busy !== null}
            className={`${secondaryButtonClass} text-warn`}
          >
            Delete
          </button>
        </div>
      )}

      {confirmingDelete && !editing ? (
        <div className="mt-3 rounded-card-sm border border-warn/35 bg-warn/[0.06] p-3">
          <p className="text-[13px] leading-relaxed text-muted">
            This permanently deletes{' '}
            <b className="font-semibold text-paper">{member.name || 'this member'}</b> — their{' '}
            {member.trackCount} {member.trackCount === 1 ? 'Track' : 'Tracks'}, Sessions, Playlists,
            People, and at least {formatBinaryBytes(member.storageBytes)} of stored files. Music
            they kept offline on their own devices stays there. It cannot be undone. Type the
            member&apos;s name to confirm.
          </p>
          <input
            type="text"
            value={confirmName}
            onChange={(event) => setConfirmName(event.target.value)}
            placeholder={member.name}
            aria-label="Type the member's name to confirm deletion"
            className={`${inputClass} mt-2`}
          />
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => void destroy()}
              disabled={busy !== null || confirmName.trim() !== member.name.trim()}
              className={`${compactPrimaryButtonClass} bg-warn`}
            >
              {busy === 'delete' ? 'Deleting…' : 'Delete forever'}
            </button>
            <button
              type="button"
              onClick={() => setConfirmingDelete(false)}
              disabled={busy !== null}
              className={secondaryButtonClass}
            >
              Keep the account
            </button>
          </div>
        </div>
      ) : null}

      {resetLink ? <ResetLink reset={resetLink} /> : null}
    </SettingsCard>
  );
}

export function MemberCards({
  members,
  tracksPerCall,
  minHeadroomTracks,
  unitCosts,
  assistantDefault,
  timezone,
}: {
  members: MembersAdminData['members'];
  tracksPerCall: number;
  minHeadroomTracks: number;
  unitCosts: UnitCosts;
  /** The instance default for Assistant access; null while no Text AI is connected. */
  assistantDefault: AssistantAccess | null;
  /** The Instance timezone the Joined and Active dates are shown in. */
  timezone: string;
}) {
  if (members.length === 0) {
    return (
      <SettingsCard>
        <p className="text-[13px] leading-relaxed text-muted">Nobody has joined yet.</p>
      </SettingsCard>
    );
  }
  return (
    <>
      {members.map((member) => (
        <MemberCard
          key={member.userId}
          member={member}
          tracksPerCall={tracksPerCall}
          minHeadroomTracks={minHeadroomTracks}
          unitCosts={unitCosts}
          assistantDefault={assistantDefault}
          timezone={timezone}
        />
      ))}
    </>
  );
}
