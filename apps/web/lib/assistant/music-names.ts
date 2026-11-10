// How a Session, Playlist or Track is named to the model: in a tool's result,
// and in what the chat panel sends back about an earlier answer. Every place
// that hands the model an id writes it this way, so the model reads one form.
// Plain text helpers, safe to import from the browser.

/** A name as the model reads it: quoted, so text a user wrote stays told apart from the rest. */
export const quoted = (name: string | null) => JSON.stringify(name ?? 'Untitled');

/** One thing by its name and the id the tools take for it. */
export const named = (name: string | null, id: string) => `${quoted(name)} (id ${id})`;

/** How many Tracks something holds, as the app counts them. */
export const trackCount = (count: number) => `${count} ${count === 1 ? 'Track' : 'Tracks'}`;
