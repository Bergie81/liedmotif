// Presentational badge showing where a credential resolved from (env, database,
// or the text LLM key Cover images share) — the UI surface of the env-first
// resolution order.

import type { CredentialSource } from '@liedmotif/db';

const badgeClass =
  'inline-block shrink-0 whitespace-nowrap rounded-[5px] border px-2 py-[2px] font-mono text-[9.5px] uppercase tracking-[0.08em]';

const SOURCE_LABELS: Record<CredentialSource, string> = {
  env: 'Environment',
  database: 'Database',
  shared: 'Shared Key',
};

export function SourceBadge({ source }: { source: CredentialSource | null }) {
  if (!source) {
    return <span className={`${badgeClass} border-line-2 text-dim`}>Not Configured</span>;
  }
  const styles = source === 'env' ? 'border-lamp/35 text-lamp' : 'border-signal/35 text-signal';
  return <span className={`${badgeClass} ${styles}`}>{SOURCE_LABELS[source]}</span>;
}
