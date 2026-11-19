// The one effective-rule implementation for cover prompt enhancement, shared by
// every web-boundary surface (regenerate, status, custom-style save): a
// configured text LLM is the hard gate, and a per-request override beats the
// owner's cover-art setting (the LLM stays optional — with none
// configured every path stays byte-for-byte deterministic).

import { getCoverArtSettings, type Database } from '@liedmotif/db';
import type { CoverDirectionInput, LlmProvider } from '@liedmotif/providers';
import { getLlmProvider } from '@/lib/providers/providers';

export interface CoverEnhancementDecision {
  /** The configured text LLM, or null — the hard gate. */
  llm: LlmProvider | null;
  /** Whether enhancement should run (LLM present AND policy says yes). */
  active: boolean;
}

export async function resolveCoverEnhancement(
  db: Database,
  ownerUserId: string,
  override?: boolean,
): Promise<CoverEnhancementDecision> {
  const llm = await getLlmProvider().catch(() => null);
  if (!llm) return { llm: null, active: false };
  return {
    llm,
    active: override ?? (await getCoverArtSettings(db, ownerUserId)).promptEnhancementEnabled,
  };
}

export interface CoverTextEnhancement {
  /** The effective text: the (clamped) rewrite when applied, else the raw input. */
  text: string;
  applied: boolean;
  /** Whether an LLM call was actually made (policy said yes and text was present). */
  attempted: boolean;
  llmConfigured: boolean;
}

/**
 * Maybe rewrite one piece of user-written cover text through the text LLM,
 * falling back to the raw text on any failure or empty rewrite. `clamp` bounds
 * the rewrite to the destination field's normalization (e.g.
 * `sanitizeCoverStyleHint` for custom style definitions).
 */
export async function enhanceCoverText(
  db: Database,
  args: {
    ownerUserId: string;
    text: string;
    override?: boolean;
    context: CoverDirectionInput['context'];
    clamp?: (raw: string) => string;
  },
): Promise<CoverTextEnhancement> {
  const { llm, active } = await resolveCoverEnhancement(db, args.ownerUserId, args.override);
  const llmConfigured = llm !== null;
  if (!llm || !active || !args.text) {
    return { text: args.text, applied: false, attempted: false, llmConfigured };
  }
  const enhanced = await llm
    .enhanceCoverDirection({ text: args.text, context: args.context })
    .catch(() => null);
  if (!enhanced?.applied) {
    return { text: args.text, applied: false, attempted: true, llmConfigured };
  }
  const clamped = args.clamp ? args.clamp(enhanced.text) : enhanced.text;
  return clamped
    ? { text: clamped, applied: true, attempted: true, llmConfigured }
    : { text: args.text, applied: false, attempted: true, llmConfigured };
}
