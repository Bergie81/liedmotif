import { Cpu, Image, Radio } from 'lucide-react';
import { getUnitCosts, readEnvLayer } from '@liedmotif/db';
import { CostsPanel } from '@/components/settings/costs-panel';
import { CredentialEditor } from '@/components/settings/credential-editor';
import { CredentialMutationGroup } from '@/components/settings/credential-mutation-group';
import { CredentialStorageWarning, ProviderCard } from '@/components/settings/provider-card';
import {
  SettingsColumns,
  SettingsPageHeader,
  SettingsSection,
  SettingsStatusBadge,
} from '@/components/settings/settings-ui';
import { StoredLlmCredentialAction } from '@/components/settings/stored-llm-credential-action';
import { IMAGE_PROVIDERS, lockedImageModel } from '@/lib/configurable-providers';
import { getDb } from '@/lib/db';
import { LLM_PROVIDERS, llmProviderMeta } from '@/lib/llm-providers';
import { loadCoverAccountAlert, loadProviderSettingsData } from '@/lib/provider-settings-data';
import { requireAdmin } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Whether deleting the stored Text AI row leaves the env-selected one running:
 * the row backs another provider than `LLM_PROVIDER` names (so nothing reads it), or
 * env alone supplies the key, model and base URL that provider's builder needs.
 * `LLM_PROVIDER` by itself is not enough — with the key only stored, the delete
 * leaves no Text AI at all.
 */
function storedLlmIsEnvFallback(storedProviderKey: string, selectedProviderKey: string): boolean {
  if (!process.env.LLM_PROVIDER?.trim()) return false;
  if (storedProviderKey !== selectedProviderKey) return true;
  const meta = llmProviderMeta(storedProviderKey);
  const env = readEnvLayer('llm', storedProviderKey);
  return Boolean(
    meta &&
    (!meta.needsKey || env.apiKey) &&
    (env.model || meta.defaultModel) &&
    (!meta.needsBaseUrl || env.baseUrl),
  );
}

export default async function ProvidersPage() {
  await requireAdmin();
  const [data, unitCosts] = await Promise.all([loadProviderSettingsData(), getUnitCosts(getDb())]);
  const music = data.music.credential;
  const llm = data.llm.credential;
  const cover = data.cover.credential;
  const lockedCoverModel = lockedImageModel(data.cover);
  // A shared key comes from the Text AI credential, so saving that one clears it too.
  const coverAccountAlert = await loadCoverAccountAlert(data.cover.providerKey, [
    { providerType: 'image', providerKey: data.cover.providerKey },
    ...(data.cover.sharesKey && llm
      ? [{ providerType: 'llm' as const, providerKey: llm.providerKey }]
      : []),
  ]);

  return (
    <section>
      <SettingsPageHeader
        title="Providers"
        description="Connect the AI services that make your music, covers and Session ideas. Your keys stay on this server."
        docs={{ path: 'providers-and-keys', label: 'How providers and keys work' }}
      />
      {!data.encryptionKeyConfigured ? <CredentialStorageWarning /> : null}

      <SettingsColumns>
        <SettingsSection
          id="music"
          title="Music"
          action={<SettingsStatusBadge status={data.music.status} />}
        >
          <ProviderCard
            icon={<Radio />}
            name={data.music.displayName}
            requirement="required"
            source={data.music.source}
            masked={music.masked}
            description="Generates the music for every track."
            environmentManaged={music.source === 'env'}
            decryptError={music.decryptError}
          >
            <CredentialMutationGroup>
              <CredentialEditor
                providerType="music"
                options={[
                  {
                    value: music.providerKey,
                    label: data.music.displayName,
                    needsKey: true,
                    needsBaseUrl: true,
                  },
                ]}
                initialProviderKey={music.providerKey}
                currentMasked={music.masked}
                configured={music.configured}
                databaseWritesEnabled={data.encryptionKeyConfigured}
                initialBaseUrl={data.music.baseUrl}
              />
            </CredentialMutationGroup>
          </ProviderCard>
        </SettingsSection>

        <SettingsSection
          id="text-llm"
          title="Text AI"
          action={<SettingsStatusBadge status={data.llm.presentation.status} />}
        >
          <ProviderCard
            icon={<Cpu />}
            name={llm ? data.llm.displayName : 'Text AI'}
            requirement="optional"
            source={data.llm.presentation.source}
            masked={llm?.masked}
            description="Used once for each Session request. Without it, your words reach the music model exactly as written, with the fine-tune picks applied."
            environmentManaged={data.llm.presentation.source === 'Environment'}
            decryptError={llm?.decryptError}
            notice={data.llm.coverKeyNotice}
          >
            <CredentialMutationGroup>
              <CredentialEditor
                providerType="llm"
                options={LLM_PROVIDERS}
                initialProviderKey={data.llm.providerKey}
                currentMasked={llm?.masked ?? null}
                configured={data.llm.presentation.configured}
                hasExistingSelection={llm !== null}
                databaseWritesEnabled={data.encryptionKeyConfigured}
                showModel
                initialBaseUrl={data.llm.settings?.baseUrl}
                initialModel={data.llm.settings?.model || undefined}
              />
              {data.storedLlmProviderKey ? (
                <StoredLlmCredentialAction
                  providerKey={data.storedLlmProviderKey}
                  environmentActive={storedLlmIsEnvFallback(
                    data.storedLlmProviderKey,
                    data.llm.providerKey,
                  )}
                  coverKeyNotice={data.llm.coverKeyNotice}
                />
              ) : null}
            </CredentialMutationGroup>
          </ProviderCard>
        </SettingsSection>

        <SettingsSection
          title="Cover images"
          action={<SettingsStatusBadge status={data.cover.status} />}
        >
          <ProviderCard
            icon={<Image />}
            name={data.cover.name}
            requirement="optional"
            source={data.cover.source}
            masked={cover?.masked}
            description="Generates Session and Playlist Covers. Without it, Covers come from the music provider, else the branded placeholder."
            environmentManaged={cover?.source === 'env'}
            decryptError={cover?.decryptError}
            accountAlert={coverAccountAlert}
          >
            <CredentialMutationGroup>
              <CredentialEditor
                providerType="image"
                options={IMAGE_PROVIDERS}
                initialProviderKey={data.cover.providerKey}
                currentMasked={cover?.masked ?? null}
                configured={data.cover.configured}
                databaseWritesEnabled={data.encryptionKeyConfigured}
                showModel
                lockedModel={lockedCoverModel}
                initialModel={lockedCoverModel ? undefined : (data.cover.model ?? undefined)}
                sharedKeyVendor={data.cover.sharedKeyVendor}
                sharesKey={data.cover.sharesKey}
              />
            </CredentialMutationGroup>
          </ProviderCard>
          <p className="mt-4 font-mono text-[10.5px] uppercase leading-[1.7] tracking-[0.05em] text-dim">
            A provider test makes only minimal free requests and never logs or returns the key.
          </p>
        </SettingsSection>

        <SettingsSection title="Unit costs">
          <CostsPanel unitCosts={unitCosts} />
        </SettingsSection>
      </SettingsColumns>
    </section>
  );
}
