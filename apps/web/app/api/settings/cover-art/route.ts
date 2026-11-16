// Save the signed-in User's own cover-art preferences (Settings → Cover art),
// Admin and Member alike — the default cover style the create card preselects,
// and their Custom cover style definition.
//
// The definition is a bounded style HINT for the cover pipeline, never the final
// image prompt — sessions started with the `Custom` cover choice copy it as their
// raw cover style hint (the worker normalizes it per session). Saving an empty
// definition clears it, which makes the `Custom` choice fall back to `auto`.

import { NextResponse } from 'next/server';
import { getCoverArtSettings, updateCoverArtSettings, type CoverArtSettings } from '@liedmotif/db';
import {
  COVER_STYLE_CHOICES,
  MAX_COVER_STYLE_HINT_LENGTH,
  sanitizeCoverStyleHint,
  type CoverStyleChoice,
} from '@liedmotif/shared';
import { enhanceCoverText } from '@/lib/cover-enhancement';
import { getDb } from '@/lib/db';
import { badRequest } from '@/lib/http';
import { readJsonObjectBody, requireOwnerId } from '@/lib/api-response';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const ownerUserId = await requireOwnerId(request);
  if (ownerUserId instanceof NextResponse) return ownerUserId;

  const body = await readJsonObjectBody(request);
  if (body instanceof NextResponse) return body;

  const patch: Partial<CoverArtSettings> = {};

  if (body.defaultStyle !== undefined) {
    const style = body.defaultStyle;
    if (typeof style !== 'string' || !(COVER_STYLE_CHOICES as readonly string[]).includes(style)) {
      return badRequest(`defaultStyle must be one of: ${COVER_STYLE_CHOICES.join(', ')}.`);
    }
    patch.defaultStyle = style as CoverStyleChoice;
  }

  if (body.customStyleDefinition !== undefined) {
    const raw = body.customStyleDefinition;
    if (typeof raw !== 'string') {
      return badRequest('customStyleDefinition must be a string.');
    }
    if (raw.length > MAX_COVER_STYLE_HINT_LENGTH) {
      return badRequest(
        `customStyleDefinition must be at most ${MAX_COVER_STYLE_HINT_LENGTH} characters.`,
      );
    }
    patch.customStyleDefinition = raw.trim();
  }

  if (body.promptEnhancementEnabled !== undefined) {
    if (typeof body.promptEnhancementEnabled !== 'boolean') {
      return badRequest('promptEnhancementEnabled must be a boolean.');
    }
    patch.promptEnhancementEnabled = body.promptEnhancementEnabled;
  }

  if (body.useStandardCoverArt !== undefined) {
    if (typeof body.useStandardCoverArt !== 'boolean') {
      return badRequest('useStandardCoverArt must be a boolean.');
    }
    patch.useStandardCoverArt = body.useStandardCoverArt;
  }

  if (Object.keys(patch).length === 0) {
    return badRequest('Nothing to update.');
  }

  const db = getDb();
  // Enhance-on-save (decision D4): a CHANGED, non-empty definition is rewritten
  // through the text LLM when enhancement is effectively on, and the ENHANCED
  // text is what gets stored — a visible write-back, so what the user sees is
  // exactly what future generations receive. Failure keeps the raw definition
  // and still saves; an unchanged definition is never re-enhanced (no drift).
  let enhancement = { attempted: false, applied: false };
  if (
    patch.customStyleDefinition &&
    patch.customStyleDefinition !==
      (await getCoverArtSettings(db, ownerUserId)).customStyleDefinition
  ) {
    const enhanced = await enhanceCoverText(db, {
      ownerUserId,
      text: patch.customStyleDefinition,
      override: patch.promptEnhancementEnabled,
      context: { style: 'custom' },
      clamp: sanitizeCoverStyleHint,
    });
    enhancement = { attempted: enhanced.attempted, applied: enhanced.applied };
    if (enhanced.applied) patch.customStyleDefinition = enhanced.text;
  }

  const settings = await updateCoverArtSettings(db, ownerUserId, patch);
  return NextResponse.json({ ok: true, settings, enhancement });
}
