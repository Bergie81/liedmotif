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
import { AssistantGlyph } from '@/components/ui/glyphs';
import { ASSISTANT_NAME } from '@/lib/assistant/persona';
import type { SettingsHubData } from '@/lib/settings/settings-hub-data';
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
        title="Set Up Liedmotif"
        description="Your profile, AI providers, cost limits, and how new sessions sound."
      />

      <SettingsColumns>
        {/* Each column's sections travel as one unbreakable block, so desktop
            reads Users, Generation & Sound and Instance beside Usage. */}
        <div className="break-inside-avoid">
          <SettingsSection title="Users">
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
              {data.assistant ? (
                <SettingsRow
                  href="/settings/assistant"
                  icon={<AssistantGlyph />}
                  label={ASSISTANT_NAME}
                  summary={data.assistant}
                />
              ) : null}
              <SettingsRow
                href="/settings/members"
                icon={<UsersRound />}
                label="Members"
                summary={{
                  status: { label: 'Admin', tone: 'muted' },
                  text: 'Invites, budgets, access',
                }}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Generation &amp; Sound">
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
                  label="My Voice"
                  summary={data.voice}
                />
              ) : null}
              <SettingsRow
                href="/settings/cover-art"
                icon={<Image />}
                label="Cover Art"
                summary={data.coverArt}
              />
            </SettingsCard>
          </SettingsSection>

          <SettingsSection title="Instance">
            <SettingsCard>
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
                label="Diagnostics &amp; Worker"
                summary={data.diagnostics}
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
                  label="Cost Limits"
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
