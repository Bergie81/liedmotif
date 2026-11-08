import {
  AudioLines,
  DatabaseBackup,
  Mic,
  Gauge,
  HardDrive,
  Image,
  KeyRound,
  ListMusic,
  Stethoscope,
  UserRound,
  UsersRound,
} from 'lucide-react';
import type { SettingsHubData } from '@/lib/settings-hub-data';
import { PricedQuantity } from './cost-readout';
import { SignOutButton } from './sign-out-button';
import {
  SettingsCard,
  SettingsColumns,
  SettingsPageHeader,
  SettingsRow,
  SettingsSection,
  SettingsUsageMeter,
} from './settings-ui';

export function SettingsHub({ data }: { data: SettingsHubData }) {
  return (
    <>
      <SettingsPageHeader
        root
        title="Set up Liedmotif"
        description="Your profile, AI providers, cost limits, and how new Sessions sound."
      />

      <SettingsColumns>
        {/* Each column's sections travel as one unbreakable block, so desktop
            reads User & instance over Generation & sound beside Usage. */}
        <div className="break-inside-avoid">
          <SettingsSection title="User &amp; instance">
            <SettingsCard>
              <SettingsRow
                href="/settings/profile"
                icon={<UserRound />}
                label="Profile"
                summary={data.profile}
              />
              <SettingsRow
                href="/settings/people"
                icon={<UsersRound />}
                label="People"
                summary={data.people}
              />
              <SettingsRow
                href="/settings/members"
                icon={<UsersRound />}
                label="Members"
                summary={{
                  status: { label: 'Admin', tone: 'muted' },
                  text: 'Invites, budgets, access',
                }}
              />
              <SettingsRow
                href="/settings/storage"
                icon={<HardDrive />}
                label="Storage"
                summary={data.storage}
              />
              <SettingsRow
                href="/settings/backups"
                icon={<DatabaseBackup />}
                label="Backups"
                summary={{
                  status: { label: 'Admin', tone: 'muted' },
                  text: 'Schedule, status, download',
                }}
              />
              <SettingsRow
                href="/settings/diagnostics"
                icon={<Stethoscope />}
                label="Diagnostics &amp; worker"
                summary={data.diagnostics}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Generation &amp; sound">
            <SettingsCard>
              <SettingsRow
                href="/settings/providers"
                icon={<KeyRound />}
                label="AI Providers"
                summary={data.providers}
              />
              <SettingsRow
                href="/settings/generation"
                icon={<ListMusic />}
                label="Generation"
                summary={data.generation}
              />
              <SettingsRow
                href="/settings/playback"
                icon={<AudioLines />}
                label="Playback"
                summary={data.playback}
              />
              {data.voice ? (
                <SettingsRow
                  href="/settings/voice"
                  icon={<Mic />}
                  label="My voice"
                  summary={data.voice}
                />
              ) : null}
              <SettingsRow
                href="/settings/cover-art"
                icon={<Image />}
                label="Cover art"
                summary={data.coverArt}
              />
            </SettingsCard>
          </SettingsSection>
        </div>

        <div className="break-inside-avoid">
          <SettingsSection id="usage" title="Usage">
            <SettingsCard>
              {data.meters.length ? (
                data.meters.map((meter) => (
                  <SettingsUsageMeter
                    key={meter.label}
                    {...meter}
                    readout={
                      <PricedQuantity
                        quantity={meter.used}
                        limit={meter.limit ?? undefined}
                        unit={meter.suffix}
                        costs={data.unitCosts}
                      />
                    }
                  />
                ))
              ) : (
                <p className="text-[13px] text-muted">Usage is unavailable.</p>
              )}
              <p className="mt-4 font-mono text-[10.5px] uppercase leading-[1.7] tracking-[0.05em] text-dim">
                {data.usageNote}
              </p>
              <div className="mt-3 border-t border-line">
                <SettingsRow
                  href="/settings/limits"
                  icon={<Gauge />}
                  label="Cost limits"
                  summary={data.limits}
                />
              </div>
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Account">
            <SettingsCard>
              <SignOutButton />
            </SettingsCard>
          </SettingsSection>
        </div>
      </SettingsColumns>
    </>
  );
}
