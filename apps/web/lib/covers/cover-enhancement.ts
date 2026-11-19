// The one effective-rule implementation for cover prompt enhancement, shared by
// every web-boundary surface (cover regenerate, custom-style save): a
// configured text LLM is the hard gate, and the custom-style save's own
// setting patch beats the owner's stored cover-art setting (the LLM stays
// optional — with none configured every path stays byte-for-byte deterministic).

import { getCoverArtSettings, type CoverRequestProvenance, type Database } from '@liedmotif/db';
import type { CoverDirectionInput, LlmProvider } from '@liedmotif/providers';
import { getLlmProvider } from '@/lib/providers/providers';

interface CoverEnhancementDecision {
  /** The configured text LLM, or null — the hard gate. */
  llm: LlmProvider | null;
  /** Whether enhancement should run (LLM present AND policy says yes). */
  active: boolean;
}

async function resolveCoverEnhancement(
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
  /** The text LLM's reading of whether the text puts the listener in the
   *  picture; absent when no call ran or it gave no valid answer. */
  includesListener?: boolean;
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
  const unchanged: CoverTextEnhancement = {
    text: args.text,
    applied: false,
    attempted: true,
    llmConfigured,
    includesListener: enhanced?.includesListener,
  };
  if (!enhanced?.applied) return unchanged;
  const clamped = args.clamp ? args.clamp(enhanced.text) : enhanced.text;
  return clamped ? { ...unchanged, text: clamped, applied: true } : unchanged;
}

/**
 * The request part of a regeneration attempt, frozen at reservation: the typed
 * art direction, what the text LLM made of it, and the People switch. Without a
 * configured text LLM there is no enhancement outcome and no listener reading.
 */
export function coverRequestProvenance(args: {
  guidance: string | undefined;
  enhancement: CoverTextEnhancement | null;
  usePeopleReferences: boolean | undefined;
}): CoverRequestProvenance {
  const reading = args.enhancement?.llmConfigured ? args.enhancement : null;
  return {
    userGuidance: args.guidance,
    usePeopleReferences: args.usePeopleReferences,
    ...(reading && {
      enhancementApplied: reading.applied,
      effectiveGuidance: reading.applied ? reading.text : undefined,
      wishIncludesListener: reading.includesListener,
    }),
  };
}
