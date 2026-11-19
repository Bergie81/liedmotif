import type { ReactNode } from 'react';
import { AlertTriangle, LockKeyhole } from 'lucide-react';
import { AlertBanner } from '@/components/ui/design-system';
import { cn } from '@/lib/cn';
import { SettingsCard, SettingsFeedback } from './settings-ui';

/** The provider's health rides the section heading, so the card head carries
 *  only what the heading cannot: which provider this is, and whether the
 *  instance needs it. */
export function ProviderCard({
  icon,
  name,
  requirement,
  source,
  masked,
  description,
  environmentManaged = false,
  decryptError = false,
  accountAlert = null,
  notice = null,
  children,
}: {
  icon: ReactNode;
  name: string;
  requirement: 'required' | 'optional';
  source: string | null;
  masked?: string | null;
  description: ReactNode;
  environmentManaged?: boolean;
  decryptError?: boolean;
  /** Why the vendor refuses this provider's account, while it does. */
  accountAlert?: string | null;
  /** A state of this provider the Admin should keep in mind before changing it. */
  notice?: string | null;
  children?: ReactNode;
}) {
  return (
    <SettingsCard>
      <div className="mb-3 flex items-center gap-3">
        <span className="shrink-0 text-muted [&>svg]:h-[19px] [&>svg]:w-[19px]">{icon}</span>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-[15px] font-semibold">
          <span>{name}</span>
          <span
            className={cn(
              'rounded-[5px] border px-2 py-[2px] font-mono text-[9.5px] font-normal uppercase tracking-[0.1em]',
              requirement === 'required' ? 'border-lamp/45 text-lamp' : 'border-line-2 text-dim',
            )}
          >
            {requirement}
          </span>
        </div>
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.06em] text-dim">
        <span>Source</span>
        <span className="rounded-[5px] border border-line-2 px-2 py-[2px] text-muted">
          {source ?? 'Not configured'}
        </span>
        {masked ? (
          <>
            <span>· Key</span>
            <b className="font-bold text-muted">{masked}</b>
          </>
        ) : null}
      </div>

      <p className="mb-4 text-[13px] text-muted">{description}</p>

      {environmentManaged ? (
        <div className="mb-4 flex items-start gap-2 rounded-card-sm border border-lamp/35 bg-lamp/[0.07] px-4 py-3 text-[13.5px]">
          <LockKeyhole className="mt-[1px] h-[17px] w-[17px] shrink-0 text-lamp" aria-hidden />
          <p className="text-muted">
            Values set in the server environment win. Their fields are locked below and name the
            variable; the others stay editable. A saved database value is only a fallback.
          </p>
        </div>
      ) : null}

      {decryptError ? (
        <AlertBanner className="mb-4">
          The stored value cannot be decrypted. Re-enter it after restoring the instance
          credential-encryption key.
        </AlertBanner>
      ) : null}

      {accountAlert ? <AlertBanner className="mb-4">{accountAlert}</AlertBanner> : null}

      {notice ? (
        <div className="mb-4">
          <SettingsFeedback kind="info">{notice}</SettingsFeedback>
        </div>
      ) : null}

      {children}
    </SettingsCard>
  );
}

export function CredentialStorageWarning() {
  return (
    <div className="mt-4 flex items-start gap-2 rounded-card-sm border border-lamp/35 bg-lamp/[0.07] px-4 py-3 text-[13.5px]">
      <AlertTriangle className="mt-[1px] h-[17px] w-[17px] shrink-0 text-lamp" aria-hidden />
      <p className="text-muted">
        <b className="font-semibold text-paper">Keys can&apos;t be stored yet.</b>{' '}
        <code className="[font-family:monospace]">CREDENTIAL_ENCRYPTION_KEY</code> is not
        configured, so database writes are blocked. Use environment settings, or configure the key
        and restart.
      </p>
    </div>
  );
}
