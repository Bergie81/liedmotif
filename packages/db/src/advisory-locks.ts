// Registry of every Postgres advisory-lock namespace this app takes. Single
// source of truth — new locks are declared HERE and imported where used, so a
// class can never be reused by accident.
//
// Postgres has TWO independent advisory-lock spaces that never collide with each
// other even at equal integers:
//
//   - Single-key space:  pg_advisory_xact_lock(bigint key).
//   - Class/key space:    pg_advisory_xact_lock(int class, int key).
//
// The single-key space holds exactly one lock: first-run setup serialization,
// `SETUP_ADVISORY_LOCK_KEY = 481723` in `setup/lock.ts` (kept there with its
// rationale). Everything below is the class/key space. Every per-owner or
// per-track key is `hashtext(id)`, which CAN evaluate to 0, so two locks sharing
// a class would share the (class, key = 0) coordinate for such an id and
// serialize unrelated work — hence one unique class each.
//
// Lock-ordering rule (deadlock avoidance): a transaction that takes
// both the owner-generation lock and the Members-Pool lock MUST take
// OWNER_GENERATION first, then MEMBERS_POOL — never the reverse. The numeric
// values do not define order (acquisition sequence does); they are laid out in
// that order only as a reading aid.

/** Per-track final-audio download; key = `hashtext(trackId)` (TRY lock). */
export const DOWNLOAD_ADVISORY_LOCK_CLASS = 9_421;

/** Per-owner generation-submit cost-control chokepoint; key = `hashtext(ownerId)`. */
export const OWNER_GENERATION_LOCK_CLASS = 9_422;

/** Members-Pool-wide admission lock; single key 0 (one Pool per instance). */
export const MEMBERS_POOL_LOCK_CLASS = 9_423;

/** Per-owner reference-photo cap; key = `hashtext(ownerId)`. */
export const OWNER_PERSON_PHOTO_LOCK_CLASS = 9_424;

/** Per-owner cover-art admission/planning; key = `hashtext(ownerId)`. */
export const OWNER_COVER_ADMISSION_LOCK_CLASS = 9_425;

/** Per-owner People mutation; key = `hashtext(ownerId)`. */
export const OWNER_PEOPLE_LOCK_CLASS = 9_426;

/** Per-owner cover-art reference-privacy; key = `hashtext(ownerId)`. */
export const OWNER_COVER_ART_LOCK_CLASS = 9_427;

/** Per-owner playlist membership/order mutation; key = `hashtext(ownerId)`. */
export const OWNER_PLAYLIST_LOCK_CLASS = 9_428;

/** Per-session Queue position assignment (`max + 1`); key = `hashtext(sessionId)`. */
export const SESSION_QUEUE_POSITION_LOCK_CLASS = 9_429;

/** Per-owner pinned-Session cap; key = `hashtext(ownerId)`. */
export const OWNER_SESSION_PIN_LOCK_CLASS = 9_430;
