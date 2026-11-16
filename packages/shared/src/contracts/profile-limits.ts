// Length caps for the fields a user's profile holds, shared by every form that
// types one and every route that stores one.

/** A person's name, wherever one is typed: invite, claim, and profile. */
export const MAX_USER_NAME_LENGTH = 80;

/** RFC 5321 path limit. */
export const MAX_EMAIL_LENGTH = 254;

/** The Settings → Profile place fields (city, country). */
export const MAX_PROFILE_FIELD_LENGTH = 120;

/** The optional exported-MP3 Artist Name. */
export const MAX_PROFILE_ARTIST_NAME_LENGTH = 80;

/** The optional Short description on the Lounge profile card. */
export const MAX_PROFILE_DESCRIPTION_LENGTH = 80;
