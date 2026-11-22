// The Assistant: the in-app chat that answers questions about Liedmotif and
// acts for the asking user. The conversation lives in the browser and travels
// whole with each request; the reply comes back as a stream of events. A
// request that is refused before a reply starts gets the ordinary error
// response instead.

import { z } from 'zod';
import { errorResponseSchema, uuidSchema } from './common';
import { COVER_STYLE_CHOICES, MAX_COVER_GUIDANCE_LENGTH, VOCAL_MODES } from './domain';
import {
  MAX_SEED_TRACKS,
  MAX_USER_PROMPT_LENGTH,
  targetDurationMinutesSchema,
  type MoreLikeThisRequest,
  type StartSessionRequest,
} from './endpoints';
import type { RegeneratePlaylistCoverRequest } from './playlist-covers';
import type { RegenerateSessionCoverRequest } from './session-covers';
import { SURPRISE_THEMES, surpriseProposalSchema, type StartSurpriseRequest } from './surprise-me';

/** How much of a conversation one request carries; the client drops older messages. */
export const ASSISTANT_MAX_MESSAGES = 12;

/**
 * Characters per message. It bounds what the user can type, and a client clips
 * an earlier answer to it before sending the conversation back.
 */
export const ASSISTANT_MAX_MESSAGE_LENGTH = 4000;

export const assistantMessageSchema = z.strictObject({
  role: z.enum(['user', 'assistant']),
  /** Plain text or Markdown. */
  content: z.string().trim().min(1).max(ASSISTANT_MAX_MESSAGE_LENGTH),
});
export type AssistantMessage = z.infer<typeof assistantMessageSchema>;

/**
 * What the browser's player has engaged when a message is sent. The player
 * lives in the browser, and a playing Playlist is unknown to the server, so
 * this is the only way the Assistant learns what "this" is. It carries ids
 * only: the server names what they point to from its own records, as far as
 * the asking user may see them.
 */
export const assistantPlayerStateSchema = z.strictObject({
  source: z.strictObject({ kind: z.enum(['session', 'playlist']), id: uuidSchema }),
  /** The Track on the deck; null while the source has none ready. */
  trackId: uuidSchema.nullable(),
  /** Audible now; false covers paused and everything short of playing. */
  playing: z.boolean(),
  /**
   * When a running Sleep Timer fades the music to silence, in epoch
   * milliseconds of the browser's clock. Left out while no timer runs.
   */
  sleepTimerEndsAt: z.number().int().positive().optional(),
});
export type AssistantPlayerState = z.infer<typeof assistantPlayerStateSchema>;

export const assistantRequestSchema = z.strictObject({
  /** Oldest first, ending with the message to answer. */
  messages: z
    .array(assistantMessageSchema)
    .min(1)
    .max(ASSISTANT_MAX_MESSAGES)
    .refine((messages) => messages.at(-1)?.role === 'user', {
      message: 'The last message must be from the user.',
    }),
  /** Left out while the player has nothing engaged. */
  player: assistantPlayerStateSchema.optional(),
});
export type AssistantRequest = z.infer<typeof assistantRequestSchema>;

/**
 * A reply is a server-sent event stream: proxies pass that content type through
 * unbuffered, so the answer appears as it is written.
 */
export const ASSISTANT_STREAM_CONTENT_TYPE = 'text/event-stream';

/** How many Tracks the Assistant adds to a Playlist in one action. */
export const ASSISTANT_MAX_TRACKS_PER_ADD = 20;

/**
 * A Track, Playlist or Session an action touched: its id, and its name as the
 * server read it then. Null is a Track or Session that has no title.
 */
const assistantActionItemSchema = z.strictObject({ id: uuidSchema, name: z.string().nullable() });
export type AssistantActionItem = z.infer<typeof assistantActionItemSchema>;

/**
 * The settings the Assistant changes for the asking user. Each is that user's
 * own, and none can raise what is spent: a setting that can is the user's to
 * change on its page.
 */
export const ASSISTANT_SETTINGS = [
  'ownerInCovers',
  'blend',
  'crossfadeSeconds',
  'defaultLanguage',
] as const;
export type AssistantSetting = (typeof ASSISTANT_SETTINGS)[number];

/**
 * What the server did for the user, in the Library or in their settings, as
 * structured values. The chat panel words the receipt from them; no text of
 * the model's is part of it.
 */
export const assistantReceiptSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('favoriteTrack'),
    track: assistantActionItemSchema,
    /** The user's Favorites Playlist, which now holds the Track. */
    playlist: assistantActionItemSchema,
  }),
  z.strictObject({
    action: z.literal('addToPlaylist'),
    playlist: assistantActionItemSchema,
    /**
     * What the Playlist keeps a Track as, so the player can show it: a Favorite,
     * a member of a hand-picked Playlist (`isCuratedPlaylist`), or only saved.
     */
    retention: z.enum(['favorite', 'curated', 'saved']),
    /** The Tracks that were added, in the Playlist's order. */
    tracks: z.array(assistantActionItemSchema).min(1).max(ASSISTANT_MAX_TRACKS_PER_ADD),
  }),
  z.strictObject({ action: z.literal('createPlaylist'), playlist: assistantActionItemSchema }),
  z.strictObject({
    action: z.literal('renamePlaylist'),
    /** Under its new name. */
    playlist: assistantActionItemSchema,
    previousName: z.string(),
  }),
  z.strictObject({ action: z.literal('pinPlaylist'), playlist: assistantActionItemSchema }),
  z.strictObject({ action: z.literal('newMusicOff'), session: assistantActionItemSchema }),
  z.strictObject({
    action: z.literal('renameSession'),
    /** Under its new name. */
    session: assistantActionItemSchema,
    /** Null for a Session that had no name. */
    previousName: z.string().nullable(),
  }),
  z.strictObject({ action: z.literal('pinSession'), session: assistantActionItemSchema }),
  z.strictObject({
    action: z.literal('renameTrack'),
    /** Under its new name. */
    track: assistantActionItemSchema,
    /** Null for a Track that had no title. */
    previousName: z.string().nullable(),
  }),
  z.strictObject({
    action: z.literal('changeSetting'),
    setting: z.enum(ASSISTANT_SETTINGS),
    /** The choice now stored and the one it replaced, each as the settings page shows it. */
    value: z.string(),
    previous: z.string(),
  }),
]);
export type AssistantReceipt = z.infer<typeof assistantReceiptSchema>;

/** The player's own transport buttons, as the Assistant names them. */
export const ASSISTANT_PLAYER_CONTROLS = [
  'pause',
  'continue',
  /** The app's Skip, with its meaning as feedback. */
  'next',
  'previous',
  'restart',
  /** Loop Track, the playback mode. */
  'loopOn',
  'loopOff',
  /** Stop Session. Not named "stop": a user who says "stop" wants the music paused. */
  'endSession',
] as const;
export type AssistantPlayerControl = (typeof ASSISTANT_PLAYER_CONTROLS)[number];

/**
 * What a play command starts, as the server read it for the asking user: a
 * Session, which plays on from where it stopped, or a Playlist, which plays
 * from its top.
 */
const assistantPlaySourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('session'), id: uuidSchema, name: z.string().nullable() }),
  z.strictObject({
    kind: z.literal('playlist'),
    id: uuidSchema,
    name: z.string(),
    trackCount: z.number().int().nonnegative(),
    /** Another user's Playlist from the asker's Lounge: it plays as a Visitor plays it. */
    foreign: z.boolean(),
  }),
]);

/**
 * The cover choices Home's form starts a new Session with by default: the
 * asker's Default cover style, left out for Auto as the start routes' own
 * default, and their Standard covers setting.
 */
const cardCoverChoicesShape = {
  coverStyle: z.enum(COVER_STYLE_CHOICES).exclude(['auto']).optional(),
  useStandardCover: z.boolean().optional(),
};

/**
 * What the browser's player is to do, as structured values: the chat panel
 * runs it through the player's own actions and words its line from it.
 */
export const assistantPlayerCommandSchema = z.discriminatedUnion('name', [
  z.strictObject({ name: z.enum(ASSISTANT_PLAYER_CONTROLS) }),
  /** Sets the Sleep Timer to `minutes` from now, replacing a running one. */
  z.strictObject({ name: z.literal('sleepTimer'), minutes: z.number().int().positive() }),
  z.strictObject({ name: z.literal('sleepTimerOff') }),
  z.strictObject({
    name: z.literal('play'),
    source: assistantPlaySourceSchema,
    /** The one Track of the source to start at; left out to play the source as it stands. */
    track: assistantActionItemSchema.optional(),
  }),
]);
export type AssistantPlayerCommand = z.infer<typeof assistantPlayerCommandSchema>;
export type AssistantPlayCommand = Extract<AssistantPlayerCommand, { name: 'play' }>;

/**
 * Something that can spend, prepared and not carried out: the values the app's
 * own route gets once the user confirms. The chat panel words the card from
 * them, and the confirmation sends them; no text of the model's is part of
 * either. Nothing exists on the server for a card.
 */
export const assistantCardSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session'),
    /** What the Session should sound like, as free text for the start-Session route. */
    prompt: z.string().min(1).max(MAX_USER_PROMPT_LENGTH),
    vocal: z.enum(VOCAL_MODES),
    /** How long the Session generates; null is No limit. Left out when it starts on Repeat and the user named no length. */
    targetDurationMinutes: targetDurationMinutesSchema.nullable().optional(),
    ...cardCoverChoicesShape,
  }),
  z.strictObject({
    kind: z.literal('changeVibe'),
    /** The active Session whose vibe changes. */
    session: assistantActionItemSchema,
    /** What should change, as the message of the Change Vibe route. */
    prompt: z.string().min(1).max(MAX_USER_PROMPT_LENGTH),
  }),
  z.strictObject({
    kind: z.literal('moreLikeThis'),
    /** The Tracks the new Session is seeded from, in the order they are sent. */
    tracks: z.array(assistantActionItemSchema).min(1).max(MAX_SEED_TRACKS),
    /** How long the Session generates; null is No limit. Left out when it starts on Repeat and the user named no length. */
    targetDurationMinutes: targetDurationMinutesSchema.nullable().optional(),
    /** What the new Session is about or for, in the user's words; left out for none. It never changes the music. */
    context: z.string().min(1).max(MAX_USER_PROMPT_LENGTH).optional(),
  }),
  z.strictObject({
    kind: z.literal('newMusicOn'),
    /** The active Session that generates again. */
    session: assistantActionItemSchema,
    /** How much music the Session may hold in all; null is No limit. */
    targetDurationMinutes: targetDurationMinutesSchema.nullable(),
  }),
  z.strictObject({
    kind: z.literal('surprise'),
    /**
     * The pending Surprise Me suggestion the start route is to start, as its
     * public preview. The Style Snapshot it starts stays on the server.
     */
    suggestion: surpriseProposalSchema.pick({
      id: true,
      adventurous: true,
      title: true,
      mood: true,
      genres: true,
      energy: true,
      vocalMode: true,
      voiceGender: true,
      language: true,
    }),
    /** How long the Session generates; null is No limit. */
    targetDurationMinutes: targetDurationMinutesSchema.nullable(),
    ...cardCoverChoicesShape,
  }),
  z.strictObject({
    kind: z.literal('cover'),
    /**
     * The asker's own Session or Playlist one new cover is generated for. Its
     * style, the enhancement setting and People reference photos stay as the
     * app has them: the card carries none of them.
     */
    subject: assistantActionItemSchema.extend({ kind: z.enum(['session', 'playlist']) }),
    /** Art direction in the user's words, as the cover dialog's field takes it; left out for none. */
    guidance: z.string().min(1).max(MAX_COVER_GUIDANCE_LENGTH).optional(),
  }),
]);
export type AssistantCard = z.infer<typeof assistantCardSchema>;
export type AssistantCoverCard = Extract<AssistantCard, { kind: 'cover' }>;

/**
 * The start-Session request a Session card stands for, less the client id only
 * the browser has. The tool checks this request before it offers the card, and
 * the confirmation sends it, so the two cannot differ.
 */
export function sessionCardStartRequest(
  card: Extract<AssistantCard, { kind: 'session' }>,
): Omit<StartSessionRequest, 'clientId'> {
  return {
    input: { mode: 'prompt', prompt: card.prompt, vocal: card.vocal },
    ...(card.targetDurationMinutes != null && {
      targetDurationMinutes: card.targetDurationMinutes,
    }),
    ...cardCoverChoices(card),
  };
}

/**
 * The More Like This request a More Like This card stands for, less the client
 * id only the browser has. No limit sends no length: that card is offered only
 * when new Sessions start on Keep Going, which the route then picks.
 */
export function moreLikeThisCardRequest(
  card: Extract<AssistantCard, { kind: 'moreLikeThis' }>,
): Omit<MoreLikeThisRequest, 'clientId'> {
  return {
    seedTrackIds: card.tracks.map(({ id }) => id),
    ...(card.targetDurationMinutes != null && {
      targetDurationMinutes: card.targetDurationMinutes,
    }),
    ...(card.context !== undefined && { context: card.context }),
  };
}

/**
 * The Surprise Me start request a Surprise Me card stands for: the
 * suggestion, its length, and the cover choices Home's form sends by default.
 */
export function surpriseCardStartRequest(
  card: Extract<AssistantCard, { kind: 'surprise' }>,
): StartSurpriseRequest {
  return {
    proposalId: card.suggestion.id,
    ...(card.targetDurationMinutes != null && {
      targetDurationMinutes: card.targetDurationMinutes,
    }),
    ...cardCoverChoices(card),
  };
}

function cardCoverChoices({
  coverStyle,
  useStandardCover,
}: Extract<AssistantCard, { kind: 'session' | 'surprise' }>) {
  return {
    ...(coverStyle !== undefined && { coverStyle }),
    ...(useStandardCover !== undefined && { useStandardCover }),
  };
}

/** The regenerate request a cover card stands for, and which of the two cover routes takes it. */
export type CoverCardRegenerateRequest =
  | { kind: 'session'; request: RegenerateSessionCoverRequest }
  | { kind: 'playlist'; request: RegeneratePlaylistCoverRequest };

/**
 * The request the cover dialog sends for the card's Session or Playlist, with
 * the card's art direction and nothing else, so every other choice is the
 * route's default.
 */
export function coverCardRegenerateRequest({
  subject,
  guidance,
}: AssistantCoverCard): CoverCardRegenerateRequest {
  const words = guidance === undefined ? {} : { guidance };
  return subject.kind === 'session'
    ? { kind: 'session', request: { activitySessionId: subject.id, ...words } }
    : { kind: 'playlist', request: { playlistId: subject.id, ...words } };
}

/**
 * Something the Assistant did while answering, by what became of it. `done` is
 * a Library action the server has carried out: the event is its receipt.
 * `player` is a command for the browser's player, which only the browser can
 * run: the server has checked it and knows nothing of what comes of it.
 * `proposed` is new spending the server only prepared: the event is a card,
 * and the user's confirmation in the browser is what carries it out.
 */
export const assistantActionSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('done'), receipt: assistantReceiptSchema }),
  z.strictObject({ status: z.literal('player'), command: assistantPlayerCommandSchema }),
  z.strictObject({ status: z.literal('proposed'), card: assistantCardSchema }),
]);
export type AssistantAction = z.infer<typeof assistantActionSchema>;

/**
 * One event of a reply stream. `text` events carry the answer's Markdown in
 * order; appending them gives the whole answer. An `action` event arrives the
 * moment the Assistant did something, between the text events or without any:
 * an answer may be actions alone. The stream then ends with exactly one of
 * `done` (the answer is complete) or `error` (it broke off, in the shape every
 * API error has). A stream that ends with neither lost its connection.
 */
export const assistantStreamEventSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('action'), action: assistantActionSchema }),
  z.strictObject({ type: z.literal('done') }),
  z.strictObject({ type: z.literal('error'), error: errorResponseSchema.shape.error }),
]);
export type AssistantStreamEvent = z.infer<typeof assistantStreamEventSchema>;

/** An event as it travels: one `data:` line of JSON, closed by a blank line. */
export function encodeAssistantStreamEvent(event: AssistantStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const EVENT_END = '\n\n';
const DATA_PREFIX = 'data: ';

/**
 * Reads a reply stream back into its events. The network cuts the stream
 * wherever it likes, so `push` takes each piece of text as it arrives and
 * returns the events that piece completed; the start of an unfinished event
 * waits for the next one. A block that is not a `data:` line is passed over. A
 * `data:` line that is none of a reply's events throws: the stream is not a
 * reply.
 */
export function createAssistantStreamDecoder(): {
  push(chunk: string): AssistantStreamEvent[];
} {
  let pending = '';
  return {
    push(chunk) {
      pending += chunk;
      const events: AssistantStreamEvent[] = [];
      let end = pending.indexOf(EVENT_END);
      while (end !== -1) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + EVENT_END.length);
        if (block.startsWith(DATA_PREFIX)) {
          events.push(
            assistantStreamEventSchema.parse(JSON.parse(block.slice(DATA_PREFIX.length))),
          );
        }
        end = pending.indexOf(EVENT_END);
      }
      return events;
    },
  };
}

/**
 * What the model passes to `readDocs`: which section of the user docs to load.
 * Lenient about extra keys — a small model adds them.
 */
export const readDocsInputSchema = z.object({
  page: z.string().describe('The page slug from the docs index, for example "members".'),
  section: z
    .string()
    .describe(
      'A section heading listed under that page, or "intro" for the text before its first heading.',
    ),
});
export type ReadDocsInput = z.infer<typeof readDocsInputSchema>;

/** What the model passes to a tool that needs nothing from it; extra keys are ignored. */
export const noToolInputSchema = z.object({});
export type NoToolInput = z.infer<typeof noToolInputSchema>;

/**
 * What the model passes to `findMusic`. Lenient where a small model slips: it
 * sends null or an empty string for what it means to leave out, and extra keys.
 */
export const findMusicInputSchema = z.object({
  kind: z.enum(['session', 'playlist', 'track']).describe('What to look for.'),
  query: z
    .string()
    .nullish()
    .describe(
      'Words to search for, as the user would type them into Search: a name, a genre, a mood. Leave out for the most recent.',
    ),
  lyrics: z
    .boolean()
    .nullish()
    .describe('Tracks only: true searches the sung lyrics for the query instead.'),
  list: z
    .enum(['saved', 'favorites', 'history'])
    .nullish()
    .describe(
      'Tracks without a query: which Library list to read. "history" is everything generated and the default.',
    ),
});
export type FindMusicInput = z.infer<typeof findMusicInputSchema>;

/**
 * What the model passes to `listTracks`. The id is any string: one that is not
 * an id at all is answered like one that names nothing.
 */
export const listTracksInputSchema = z.object({
  in: z.enum(['session', 'playlist']).describe('Whether the id is a Session or a Playlist.'),
  id: z.string().describe('The id of the Session or Playlist, as another tool returned it.'),
});
export type ListTracksInput = z.infer<typeof listTracksInputSchema>;

/**
 * What the model passes to `readTrack`. Lenient like the other read tools: the
 * id is any string, and one left out means the Track that is playing.
 */
export const readTrackInputSchema = z.object({
  trackId: z
    .string()
    .nullish()
    .describe(
      'The id of the Track, as another tool returned it. Leave out for the Track that is playing now ("this").',
    ),
});
export type ReadTrackInput = z.infer<typeof readTrackInputSchema>;

/**
 * What the model passes to `favoriteTrack`. Lenient like the read tools: the
 * id is any string, and one left out means the Track that is playing.
 */
export const favoriteTrackInputSchema = z.object({
  trackId: z
    .string()
    .nullish()
    .describe(
      'The id of the Track, as another tool returned it. Leave out for the Track that is playing now ("this").',
    ),
});
export type FavoriteTrackInput = z.infer<typeof favoriteTrackInputSchema>;

/** What the model passes to `addToPlaylist`. More Tracks than the cap is answered, not cut. */
export const addToPlaylistInputSchema = z.object({
  playlistId: z.string().describe('The id of the Playlist, as another tool returned it.'),
  trackIds: z
    .array(z.string())
    .nullish()
    .describe(
      `The ids of the Tracks to add, in the order to add them, at most ${ASSISTANT_MAX_TRACKS_PER_ADD}. Leave out for the Track that is playing now ("this").`,
    ),
});
export type AddToPlaylistInput = z.infer<typeof addToPlaylistInputSchema>;

/** What the model passes to `createPlaylist`. The name is checked like the app's own field. */
export const createPlaylistInputSchema = z.object({
  name: z.string().describe('The name of the new Playlist, as the user said it.'),
});
export type CreatePlaylistInput = z.infer<typeof createPlaylistInputSchema>;

/** What the model passes to `renamePlaylist`. */
export const renamePlaylistInputSchema = z.object({
  playlistId: z.string().describe('The id of the Playlist, as another tool returned it.'),
  name: z.string().describe('The new name, as the user said it.'),
});
export type RenamePlaylistInput = z.infer<typeof renamePlaylistInputSchema>;

/** What the model passes to `pinPlaylist`. */
export const pinPlaylistInputSchema = z.object({
  playlistId: z.string().describe('The id of the Playlist, as another tool returned it.'),
});
export type PinPlaylistInput = z.infer<typeof pinPlaylistInputSchema>;

/**
 * What the model passes to `renameSession`. The id is any string, and one left
 * out means the Session the player has on.
 */
export const renameSessionInputSchema = z.object({
  sessionId: z
    .string()
    .nullish()
    .describe(
      'The id of the Session, as another tool returned it. Leave out for the Session that is playing now ("this").',
    ),
  name: z.string().describe('The new name, as the user said it.'),
});
export type RenameSessionInput = z.infer<typeof renameSessionInputSchema>;

/** What the model passes to `pinSession`. An id left out means the Session the player has on. */
export const pinSessionInputSchema = z.object({
  sessionId: z
    .string()
    .nullish()
    .describe(
      'The id of the Session, as another tool returned it. Leave out for the Session that is playing now ("this").',
    ),
});
export type PinSessionInput = z.infer<typeof pinSessionInputSchema>;

/** What the model passes to `renameTrack`. An id left out means the Track on the player's deck. */
export const renameTrackInputSchema = z.object({
  trackId: z
    .string()
    .nullish()
    .describe(
      'The id of the Track, as another tool returned it. Leave out for the Track that is playing now ("this").',
    ),
  name: z.string().describe('The new title, as the user said it.'),
});
export type RenameTrackInput = z.infer<typeof renameTrackInputSchema>;

/** What the model passes to `changeSetting`. */
export const changeSettingInputSchema = z.object({
  setting: z.enum(ASSISTANT_SETTINGS).describe('The setting to change.'),
  value: z
    .string()
    .describe('The new choice for it, as the tool description lists the choices of that setting.'),
});
export type ChangeSettingInput = z.infer<typeof changeSettingInputSchema>;

/** What the model passes to `playerControl`. */
export const playerControlInputSchema = z.object({
  command: z
    .enum(ASSISTANT_PLAYER_CONTROLS)
    .describe(
      'pause halts the music and continue plays on. next is Skip, previous goes back one Track, restart plays the current Track from its start. loopOn is Loop Track: the current Track plays again and again until loopOff. endSession is Stop Session in the app: it ends the Session, which then generates nothing until it is resumed. Use it only when the user asks to end or close the Session; when they say "stop" or "stop the music", use pause.',
    ),
});
export type PlayerControlInput = z.infer<typeof playerControlInputSchema>;

/** What the model passes to `sleepTimer`: a time to set, or `off`. A time outside the range is answered, not rounded. */
export const sleepTimerInputSchema = z.object({
  minutes: z
    .number()
    .nullish()
    .describe('In how many minutes the music fades out and pauses, counted from now.'),
  off: z.boolean().nullish().describe('true cancels the running Sleep Timer instead.'),
});
export type SleepTimerInput = z.infer<typeof sleepTimerInputSchema>;

/**
 * What the model passes to `play`. The ids are any strings: one that is not an
 * id at all is answered like one that names nothing.
 */
export const playInputSchema = z.object({
  kind: z
    .enum(['session', 'playlist', 'track'])
    .describe(
      'What the id names. "session" resumes a Session where it stopped, "playlist" plays a Playlist from its top, "track" plays one Track of the user\'s own.',
    ),
  id: z
    .string()
    .describe('The id of that Session, Playlist or Track, as another tool returned it.'),
  trackId: z
    .string()
    .nullish()
    .describe(
      'With "session" or "playlist" only: the id of the one Track in it to start at. Leave out to play it as it stands.',
    ),
});
export type PlayInput = z.infer<typeof playInputSchema>;

/**
 * The length a new Session's propose tool takes, as the user said it: minutes
 * when they named a length, `noLimit` when they asked for none, neither when
 * they said nothing (the tool then answers instead of guessing).
 */
const newSessionLengthInput = {
  targetDurationMinutes: z
    .number()
    .nullish()
    .describe('How long the Session should run, in minutes. Only when the user named a length.'),
  noLimit: z
    .boolean()
    .nullish()
    .describe('true only when the user asked for a Session without a limit.'),
};

/**
 * What the model passes to `proposeSession`. Lenient like the other tools; the
 * values are checked against the start-Session request before a card is offered.
 * A length and `noLimit` carry what the user said, never a guess: the tool
 * answers when it needs one of them.
 */
export const proposeSessionInputSchema = z.object({
  prompt: z
    .string()
    .describe(
      'What the Session should sound like, in the words the user used: the mood, the activity, the style.',
    ),
  vocal: z
    .boolean()
    .nullish()
    .describe('true only when the user asked for vocals or singing. Leave out for instrumental.'),
  ...newSessionLengthInput,
});
export type ProposeSessionInput = z.infer<typeof proposeSessionInputSchema>;

/** What the model passes to `proposeChangeVibe`. The words are checked like the app's own Change Vibe message. */
export const proposeChangeVibeInputSchema = z.object({
  prompt: z
    .string()
    .describe(
      'What should change about the music, in the words the user used: "slower", "add a cello", "more upbeat".',
    ),
});
export type ProposeChangeVibeInput = z.infer<typeof proposeChangeVibeInputSchema>;

/**
 * What the model passes to `proposeMoreLikeThis`. More Tracks than the cap is
 * answered, not cut. A length and `noLimit` carry what the user said, as on
 * `proposeSession`. A context is checked like the More Like This route's own.
 */
export const proposeMoreLikeThisInputSchema = z.object({
  trackIds: z
    .array(z.string())
    .nullish()
    .describe(
      `The ids of the Tracks the new Session should sound like, at most ${MAX_SEED_TRACKS}, as another tool returned them. Leave out for the Track that is playing now ("more like this").`,
    ),
  context: z
    .string()
    .nullish()
    .describe(
      'What the new Session is about or for, in the words the user used: "for cooking", "for Anna\'s birthday", "about autumn in Berlin". Only when the user named one. Never a change to the sound.',
    ),
  ...newSessionLengthInput,
});
export type ProposeMoreLikeThisInput = z.infer<typeof proposeMoreLikeThisInputSchema>;

/** What the model passes to `proposeNewMusicOn`: a length, or `noLimit`. Neither is answered, not guessed. */
export const proposeNewMusicOnInputSchema = z.object({
  targetDurationMinutes: z
    .number()
    .nullish()
    .describe(
      'How many minutes of music the Session may hold in all; it generates until it has that much. Only when the user named a length.',
    ),
  noLimit: z
    .boolean()
    .nullish()
    .describe('true when the user asked for new music without a limit.'),
});
export type ProposeNewMusicOnInput = z.infer<typeof proposeNewMusicOnInputSchema>;

/**
 * What the model passes to `proposeSurprise`: what the user asked of the
 * suggestion, each left out when they did not say. A length is checked like
 * the start route's before anything is written. No language and no Start
 * without profile: those stay on Home.
 */
export const proposeSurpriseInputSchema = z.object({
  adventurous: z
    .boolean()
    .nullish()
    .describe(
      'true when the user wants something more adventurous: new, different, away from their usual taste. Leave out for familiar.',
    ),
  theme: z
    .enum(SURPRISE_THEMES)
    .nullish()
    .describe(
      'The situation the user named: morning, focus (work, study), movement (a workout, a run, dancing), travel (a trip, a drive), home, friends (a party, company), rest (relaxing, sleep), mood (a feeling), place (somewhere), about-me (a song about the user, always sung). Leave out when they named none.',
    ),
  vocal: z
    .enum(['vocal', 'instrumental'])
    .nullish()
    .describe(
      'Only when the user asked for vocals or for instrumental. Leave out to follow their taste.',
    ),
  ...newSessionLengthInput,
});
export type ProposeSurpriseInput = z.infer<typeof proposeSurpriseInputSchema>;

/**
 * What the model passes to `proposeCover`. The id is any string, and one left
 * out means the Session or Playlist the player has on. The art direction is
 * checked like the cover dialog's field before a card is offered.
 */
export const proposeCoverInputSchema = z.object({
  in: z
    .enum(['session', 'playlist'])
    .describe('Whether the new cover is for a Session or for a Playlist.'),
  id: z
    .string()
    .nullish()
    .describe(
      'The id of the Session or Playlist, as another tool returned it. Leave out for the one that is playing now ("this").',
    ),
  guidance: z
    .string()
    .nullish()
    .describe(
      'Art direction in the user\'s own words, such as "darker, neon city". Leave out when they gave none.',
    ),
});
export type ProposeCoverInput = z.infer<typeof proposeCoverInputSchema>;
