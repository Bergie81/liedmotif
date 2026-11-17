'use client';

// Mint and manage Member invites: label + starting budget → a link the Admin
// copies, or, with account email on, a mail to the Member's address, which
// becomes their login. Outstanding invites list with revoke; everything
// re-reads through router.refresh() like every other settings surface.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { UserRoundPlus } from 'lucide-react';
import {
  MAX_EMAIL_LENGTH,
  MAX_USER_NAME_LENGTH,
  type MemberLimits,
  type UnitCosts,
} from '@liedmotif/shared';
import { apiFetch, apiFetchJson } from '@/lib/api-fetch';
import {
  compactPrimaryButtonClass,
  inputClass,
  secondaryButtonClass,
} from '@/components/ui/form-styles';
import type { MembersAdminData } from '@/lib/members-admin-data';
import { toast } from '@/lib/toast';
import { SettingsCard } from '../settings-ui';
import { CopyLinkBox } from './copy-link-box';
import { MemberBudgetKindFields } from './member-budget-fields';
import {
  buildMemberBudgetKindPatch,
  formatShortDate,
  memberBudgetFormValues,
  newInviteTotals,
} from './members-admin-model';
import { useMemberBudgetForm } from './use-member-budget-form';

export function InviteMembersSection({
  invites,
  inviteByEmail,
  defaultBudget,
  tracksPerCall,
  unitCosts,
}: {
  invites: MembersAdminData['invites'];
  /** Account email is on: the Invite is mailed, never shown as a link. */
  inviteByEmail: boolean;
  defaultBudget: MemberLimits;
  tracksPerCall: number;
  unitCosts: UnitCosts;
}) {
  const router = useRouter();
  const [label, setLabel] = useState('');
  const [email, setEmail] = useState('');
  // A new invite starts One-time: the common case is one total to test with.
  const { kind, setKind, values, errors, change, setErrors } = useMemberBudgetForm(
    () => ({
      ...memberBudgetFormValues(defaultBudget, tracksPerCall),
      ...newInviteTotals(tracksPerCall),
    }),
    'oneTime',
  );
  const [busy, setBusy] = useState(false);
  const [mintedUrl, setMintedUrl] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  const createLabel = inviteByEmail
    ? { idle: 'Send invite', busy: 'Sending invite…' }
    : { idle: 'Create invite link', busy: 'Creating invite…' };

  async function create() {
    if (busy) return;
    setMintedUrl(null);
    const parsed = buildMemberBudgetKindPatch(kind, values, tracksPerCall);
    if (!parsed.ok) {
      setErrors(parsed.errors);
      return;
    }
    if (!label.trim()) {
      toast.error('Give the invite a name — who is this for?', { key: 'invite-create' });
      return;
    }
    if (inviteByEmail && !email.trim()) {
      toast.error('Enter the email address to send the invite to.', { key: 'invite-create' });
      return;
    }
    setBusy(true);
    const result = await apiFetchJson<{ url?: string }>('/api/settings/members/invites', 'POST', {
      label: label.trim(),
      budget: parsed.patch,
      ...(inviteByEmail ? { email: email.trim() } : {}),
    });
    setBusy(false);
    if (!result.ok) {
      toast.error(result.message, { key: 'invite-create' });
      return;
    }
    toast.dismiss('invite-create');
    if (result.data.url) setMintedUrl(result.data.url);
    else toast.success(`Invite sent to ${email.trim()}. The link works for 7 days.`);
    setLabel('');
    setEmail('');
    router.refresh();
  }

  async function revoke(id: string) {
    if (revokingId) return;
    setRevokingId(id);
    const result = await apiFetch(`/api/settings/members/invites/${id}`, { method: 'DELETE' });
    setRevokingId(null);
    if (result.ok) toast.dismiss('invite-revoke');
    else toast.error(result.message, { key: 'invite-revoke' });
    router.refresh();
  }

  return (
    <SettingsCard>
      <label className="flex flex-col gap-2 text-[13px] font-semibold text-paper">
        Who is this invite for?
        <input
          type="text"
          value={label}
          maxLength={MAX_USER_NAME_LENGTH}
          placeholder="Lisa"
          disabled={busy}
          onChange={(event) => setLabel(event.target.value)}
          className={inputClass}
        />
      </label>
      {inviteByEmail ? (
        <label className="mt-4 flex flex-col gap-2 text-[13px] font-semibold text-paper">
          Their email
          <input
            type="email"
            autoComplete="off"
            value={email}
            maxLength={MAX_EMAIL_LENGTH}
            placeholder="lisa@example.com"
            disabled={busy}
            onChange={(event) => setEmail(event.target.value)}
            className={inputClass}
          />
          <span className="text-[11.5px] font-normal leading-[1.5] text-dim">
            The invite is mailed here, and it becomes their sign-in email.
          </span>
        </label>
      ) : null}
      <div className="mt-4">
        <MemberBudgetKindFields
          kind={kind}
          onKindChange={setKind}
          values={values}
          errors={errors}
          disabled={busy}
          tracksPerCall={tracksPerCall}
          unitCosts={unitCosts}
          onChange={change}
        />
      </div>
      <button
        type="button"
        onClick={() => void create()}
        disabled={busy}
        className={`${compactPrimaryButtonClass} mt-4`}
      >
        <UserRoundPlus className="h-4 w-4" aria-hidden />
        {busy ? createLabel.busy : createLabel.idle}
      </button>
      {mintedUrl ? <CopyLinkBox url={mintedUrl} label="Invite link" /> : null}

      {invites.length > 0 ? (
        <div className="mt-5 border-t border-line pt-4">
          <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-dim">
            Open invites
          </p>
          {invites.map((invite) => (
            <div
              key={invite.id}
              className="flex items-center gap-3 border-b border-line py-2.5 last:border-b-0"
            >
              <div className="min-w-0 flex-1">
                <b className="block truncate text-[13.5px] font-semibold">{invite.label}</b>
                {invite.email ? (
                  <span className="block truncate text-[12px] text-muted">{invite.email}</span>
                ) : null}
                <span className="block font-mono text-[10.5px] uppercase tracking-[0.05em] text-dim">
                  Expires {formatShortDate(invite.expiresAt)}
                </span>
              </div>
              <button
                type="button"
                onClick={() => void revoke(invite.id)}
                disabled={revokingId !== null}
                className={secondaryButtonClass}
              >
                {revokingId === invite.id ? 'Revoking…' : 'Revoke'}
              </button>
            </div>
          ))}
        </div>
      ) : null}
    </SettingsCard>
  );
}
