import { describe, expect, it } from 'vitest';
import { canReadCover } from './owned-content';

const OWNER = 'owner-1';
const STRANGER = 'member-2';
// The admin holds no special viewer id — there is nothing to pass that widens
// the predicate. This constant documents the no-override rule: an admin who is
// not the owner is just another non-owner.
const ADMIN_WHO_IS_NOT_OWNER = 'admin-1';

/** The fields the predicate reads: the row's kind, the owner it names, and —
 *  when the caller resolved it — whether the Lounge currently exposes it. */
function cover(
  sourceType: string,
  provenanceOwnerUserId: string | null,
  loungeVisible?: boolean,
): { sourceType: string; provenanceOwnerUserId: string | null; loungeVisible?: boolean } {
  return {
    sourceType,
    provenanceOwnerUserId,
    ...(loungeVisible !== undefined ? { loungeVisible } : {}),
  };
}

describe('owned-content access seam', () => {
  describe('canReadCover', () => {
    it('serves an owner-attributed cover to its owner alone', () => {
      expect(canReadCover(OWNER, cover('generated', OWNER))).toBe(true);
      expect(canReadCover(STRANGER, cover('generated', OWNER))).toBe(false);
    });

    it('refuses an admin who is not the owner (no admin override, by decision)', () => {
      expect(canReadCover(ADMIN_WHO_IS_NOT_OWNER, cover('generated', OWNER))).toBe(false);
    });

    it('serves the built-in placeholder to every signed-in profile', () => {
      expect(canReadCover(STRANGER, cover('placeholder', null))).toBe(true);
    });

    it('refuses an ownerless cover that is not the placeholder', () => {
      expect(canReadCover(STRANGER, cover('generated', null))).toBe(false);
      expect(canReadCover(OWNER, cover('uploaded', null))).toBe(false);
    });

    // The Lounge widening: Lounge visibility is the grant, so it must not
    // depend on who the provenance names — an ownerless row the Lounge exposes
    // still serves (the grant is anchored on the OWNER's share, resolved in
    // SQL before this predicate runs).
    it('serves a Lounge-visible cover to any signed-in viewer', () => {
      expect(canReadCover(STRANGER, cover('generated', OWNER, true))).toBe(true);
      expect(canReadCover(ADMIN_WHO_IS_NOT_OWNER, cover('generated', OWNER, true))).toBe(true);
      expect(canReadCover(STRANGER, cover('generated', null, true))).toBe(true);
    });

    it('keeps the owner-only refusal when the Lounge does not expose the cover', () => {
      expect(canReadCover(STRANGER, cover('generated', OWNER, false))).toBe(false);
      expect(canReadCover(STRANGER, cover('generated', null, false))).toBe(false);
    });
  });
});
