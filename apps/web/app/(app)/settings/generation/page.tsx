import { getGenerationSettings, getUnitCosts, getUsageLimits } from '@liedmotif/db';
import { GenerationForm } from '@/components/settings/generation-form';
import { LanguageForm } from '@/components/settings/language-form';
import { LimitsForm } from '@/components/settings/limits-form';
import {
  SettingsCard,
  SettingsColumns,
  SettingsPageHeader,
  SettingsSection,
} from '@/components/settings/settings-ui';
import { getDb } from '@/lib/db';
import { getTypicalTracksPerMusicRequest } from '@/lib/providers';
import { requireAppAccess } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function GenerationSettingsPage() {
  const { session, role } = await requireAppAccess();
  // Buffer and language are owner-scoped and belong to both roles; the cost
  // controls are instance configuration and render (and load) for the Admin
  // alone — a Member's budget lives on Settings → My budget instead.
  const isAdmin = role === 'admin';
  const tracksPerRequest = getTypicalTracksPerMusicRequest();
  const [settings, limits, unitCosts] = await Promise.all([
    getGenerationSettings(getDb(), session.user.id),
    isAdmin ? getUsageLimits(getDb()) : null,
    isAdmin ? getUnitCosts(getDb()) : null,
  ]);
  return (
    <section>
      <SettingsPageHeader
        title={isAdmin ? 'Generation & cost' : 'Generation'}
        description={
          isAdmin
            ? 'Set the limits that keep spending in check, the language Sessions use, and how far ahead they generate.'
            : 'Set the language Sessions use and how far ahead they generate.'
        }
        docs={
          isAdmin ? { path: 'costs-and-limits', label: 'How costs and limits work' } : undefined
        }
      />
      <SettingsColumns>
        {limits && unitCosts ? (
          // One unbreakable block, so the cost controls fill the first column
          // and Language and Buffer the second.
          <div className="break-inside-avoid">
            <LimitsForm
              initial={limits}
              tracksPerRequest={tracksPerRequest}
              unitCosts={unitCosts}
            />
          </div>
        ) : null}
        <SettingsSection title="Language">
          <SettingsCard>
            <LanguageForm initial={settings} />
          </SettingsCard>
        </SettingsSection>
        <SettingsSection title="Buffer">
          <SettingsCard>
            <GenerationForm initial={settings} />
          </SettingsCard>
        </SettingsSection>
      </SettingsColumns>
    </section>
  );
}
