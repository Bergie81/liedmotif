// Mock text-LLM provider — tests/dev only, never user-facing. It implements the
// LlmProvider contract deterministically and WITHOUT the AI SDK or any network, so
// the free-text create path can be exercised offline. Expansion derives a snapshot
// from the intent text; the Assistant's reply follows a script.

import { MAX_COVER_GUIDANCE_LENGTH, tokenize, type CoverStylePreset } from '@liedmotif/shared';
import {
  clampActivity,
  clampLyricContext,
  clampTrackLyricBrief,
  MAX_STYLE_PROMPT_LENGTH,
  sessionStyleSnapshotSchema,
  type SessionStyleSnapshot,
} from './snapshot';
import { deriveSessionTitle, type SessionNamingMetadata } from './session-title';
import {
  applyStylePicks,
  deriveTrackMetadata,
  freezeStyleParameters,
  type StylePicks,
  type TrackMetadata,
} from './template';
import { takenTitles } from './session-prompts';
import type {
  AssistantReplyInput,
  ExpansionOptions,
  ListenerContext,
  LlmProvider,
  LlmProviderCapabilities,
  SessionNamingInput,
  SurpriseRequestInput,
  TrackLyricBriefInput,
  TrackTitlesInput,
} from './index';

const DEFAULT_STYLE = 'instrumental ambient, medium energy';

const MOCK_TITLE_ADJECTIVES = [
  'Velvet',
  'Silver',
  'Hidden',
  'Golden',
  'Quiet',
  'Distant',
  'Neon',
  'Paper',
];
const MOCK_TITLE_NOUNS = [
  'Harbor',
  'Lanterns',
  'Avenue',
  'Tide',
  'Signal',
  'Orchard',
  'Echoes',
  'Skyline',
];

/** The mock's fixed Auto cover pick, so tests exercise the stored-pick path. */
export const MOCK_AUTO_COVER_STYLE: CoverStylePreset = 'photographic';

// Naive deterministic stand-ins for the real model's vocal/language detection,
// so dev/manual testing with the mock exercises the vocal-language path at all
// (a real model reads the whole request; the mock just pattern-matches).
const VOCAL_HINT =
  /\b(vocals?|sing(?:ing|er)?|song|lyrics|aria|choir|choral|gesang|singen|lied)\b/i;
const GERMAN_HINT = /\b(der|die|das|ein|eine|für|über|mit|und|gesang|singen|lied)\b/i;
// The same kind of stand-in for the real model's reading of whether the
// request puts the listener in its scene: "me" as a participant ("about me",
// "me and Jonas", "put me in it"), not as whoever the music is for ("play me").
const LISTENER_HINT =
  /\b(?:about|with|and|put)\s+(?:me|myself|us)\b|\b(?:me|I|we)\s*(?:,|and\b)|\bmyself\b/i;

function relevantAbout(about: string, requestContext: string): string {
  const requestTerms = new Set(tokenize(requestContext).filter((term) => term.length >= 4));
  return about
    .split(/[.!?;\n]+/u)
    .map((fact) => fact.trim())
    .filter(
      (fact) =>
        fact.length > 0 &&
        tokenize(fact).some((term) => requestTerms.has(term) && term.length >= 4),
    )
    .join(', ');
}

function mockLyricContext(
  listener: ListenerContext,
  includePeople: boolean,
  requestContext = '',
): string {
  const notes: string[] = [];
  const name = listener.name?.trim();
  if (name) notes.push(`people: ${name}`);
  const setting = [listener.city, listener.country]
    .flatMap((value) => (value?.trim() ? [value.trim()] : []))
    .join(', ');
  if (setting) notes.push(`setting: ${setting}`);
  if (includePeople) {
    const ownAbout = relevantAbout(listener.about?.trim() ?? '', requestContext);
    if (ownAbout) notes.push(`listener: ${ownAbout}`);
    for (const person of listener.people ?? []) {
      const name = person.name.trim();
      const about = relevantAbout(person.about.trim(), requestContext);
      if (name && about) notes.push(`people: ${name}; story moments: ${about}`);
    }
  }
  return clampLyricContext(notes.join('; '));
}

/** The pre-pick snapshot an expansion starts from. An adjustment anchors on the
 *  running snapshot (the `adjustFrom` contract): the change text rides onto the
 *  style and every other facet — genres, vocal mode, language, frozen bpm/key —
 *  holds, the deterministic stand-in for the real adjustment prompt. A
 *  picks-only adjustment has no change text, so the style holds too. Explicit
 *  picks are enforced afterwards and win over the anchor. */
function baseSnapshot(
  text: string,
  anchor: SessionStyleSnapshot | undefined,
): SessionStyleSnapshot {
  if (anchor) {
    return sessionStyleSnapshotSchema.parse({
      ...anchor,
      stylePrompt: text
        ? `${anchor.stylePrompt}, ${text}`.slice(0, MAX_STYLE_PROMPT_LENGTH)
        : anchor.stylePrompt,
    });
  }
  return sessionStyleSnapshotSchema.parse({
    stylePrompt: text.slice(0, MAX_STYLE_PROMPT_LENGTH),
    genreTags: tokenize(text).slice(0, 3),
    vocalMode: VOCAL_HINT.test(text) ? 'vocal' : 'instrumental',
  });
}

/** What the mock does with an Assistant conversation, in place of a model deciding. */
export interface MockAssistantScript {
  /** Tool calls to make, in order, before answering. */
  toolCalls?: ReadonlyArray<{ name: string; input: unknown }>;
  /** The answer, from what each tool call returned. */
  reply(toolResults: string[]): string;
}

export function mockLlmProvider(
  options: { assistantScript?: MockAssistantScript } = {},
): LlmProvider {
  return {
    providerType: 'llm',
    providerKey: 'mock',

    getCapabilities(): LlmProviderCapabilities {
      return { supportsStructuredOutputs: true, model: 'mock' };
    },

    async validateCredentials() {
      return { ok: true, message: 'Mock provider needs no credentials.' };
    },

    async expandSessionIntent(
      intent: string,
      listener?: ListenerContext | null,
      picks?: StylePicks,
      options?: ExpansionOptions,
    ): Promise<SessionStyleSnapshot> {
      const text = intent.trim() || (options?.adjustFrom ? '' : DEFAULT_STYLE);
      const base = baseSnapshot(text, options?.adjustFrom);
      // Explicit picks are enforced first, so the vocal-only fields below follow
      // the FORCED mode (a picked vocal still gets a language; a picked
      // instrumental never does), and they join the frozen fingerprint.
      const picked = applyStylePicks(base, picks);
      const vocal = picked.vocalMode === 'vocal';
      // Freeze a deterministic BPM/key + seed so the mock's free-text
      // path produces the same blend-ready shape as the structured template.
      const snapshot = freezeStyleParameters({
        ...picked,
        // An explicit language pick (already enforced by `applyStylePicks`)
        // wins; otherwise the mock's naive detection recognizes German on vocal
        // requests and everything else stays '' (no tag).
        language: picked.language || (vocal && GERMAN_HINT.test(text) ? 'German' : ''),
      });
      if (!vocal) return snapshot;
      // An adjustment EDITS the running lyrical direction; with no model to reason
      // with, the mock's deterministic edit is "unchanged" — the anchor's notes rode
      // in through `baseSnapshot`, and fresh ones are derived only when it has none.
      if (options?.adjustFrom?.lyricContext) return snapshot;
      // Skip-profile sessions source lyric notes from the request alone —
      // deterministic stand-in for the real model's request-derived notes.
      if (options?.skipProfile) {
        return text
          ? { ...snapshot, lyricContext: clampLyricContext(`story moments: ${text}`) }
          : snapshot;
      }
      return listener
        ? { ...snapshot, lyricContext: mockLyricContext(listener, true, text) }
        : snapshot;
    },

    async expandSessionIntentWithMetadata(
      intent: string,
      listener?: ListenerContext | null,
      picks?: StylePicks,
      options?: ExpansionOptions,
    ) {
      const snapshot = await this.expandSessionIntent(intent, listener, picks, options);
      return {
        snapshot,
        coverConcept: `One concrete visual metaphor for ${deriveSessionTitle({ userPrompt: intent, snapshot })}`,
        autoCoverStyle: MOCK_AUTO_COVER_STYLE,
        ...(LISTENER_HINT.test(intent) ? { includesListener: true } : {}),
      };
    },

    async createTrackMetadata(
      snapshot: SessionStyleSnapshot,
      trackIndex = 0,
    ): Promise<TrackMetadata> {
      return deriveTrackMetadata(snapshot, trackIndex);
    },

    async createSessionMetadata(input: SessionNamingInput): Promise<SessionNamingMetadata> {
      // Deterministic stand-in for a creative model: a derived Name plus a small
      // titled pool, so dev/tests exercise the pool-based track-title path. A vocal
      // session with a listener profile also gets deterministic labeled notes, so
      // dev/tests exercise the same personalization shape as a real model.
      const base = deriveSessionTitle({
        userPrompt: input.userPrompt,
        snapshot: { ...input.snapshot, title: '' },
      });
      const taken = new Set(takenTitles(input.avoidTitles).map((name) => name.toLowerCase()));
      const title = taken.has(base.toLowerCase()) ? `${base} II` : base;
      const lyricContext =
        input.snapshot.vocalMode === 'vocal' && input.listener
          ? mockLyricContext(input.listener, false)
          : '';
      const named = {
        title,
        trackTitles: ['Dawn', 'Drift', 'Glow', 'Ember'].map((word) => `${title} ${word}`),
        lyricContext,
        coverConcept: `A concrete visual interpretation of ${title}`,
        autoCoverStyle: MOCK_AUTO_COVER_STYLE,
      };
      const context = input.context?.trim();
      if (!context) return named;
      // A context's deterministic stand-in: the seed's notes gain the context as
      // their theme, and the context itself stands in for the activity.
      const seedNotes = input.snapshot.lyricContext.trim();
      return {
        ...named,
        activity: clampActivity(context),
        lyricContext:
          input.snapshot.vocalMode === 'vocal'
            ? clampLyricContext(seedNotes ? `theme: ${context}; ${seedNotes}` : `theme: ${context}`)
            : '',
      };
    },

    async createTrackLyricBrief(input: TrackLyricBriefInput): Promise<string> {
      // Deterministic stand-in for the real model's variety rule: the angle index
      // follows how many briefs the session already has, so consecutive
      // generations get observably different briefs offline.
      return clampTrackLyricBrief(
        `focus ${input.previousBriefs.length + 1}: ${input.lyricContext}`,
      );
    },

    async createTrackTitles(input: TrackTitlesInput): Promise<string[]> {
      // Deterministic stand-in: adjective × noun pairs, skipping taken ones.
      const pairs = MOCK_TITLE_NOUNS.flatMap((noun) =>
        MOCK_TITLE_ADJECTIVES.map((word) => `${word} ${noun}`),
      );
      const taken = new Set(input.takenTitles.map((title) => title.toLowerCase()));
      return pairs.filter((title) => !taken.has(title.toLowerCase())).slice(0, input.count);
    },

    async createSurpriseRequest(input: SurpriseRequestInput) {
      // Deterministic stand-in: the subject and the music, as a listener might type them.
      return {
        request: `${input.subject} — ${input.music}.`,
        energy: 'medium' as const,
        durationMinutes: 30,
      };
    },

    async enhanceCoverDirection(input) {
      const trimmed = input.text.trim();
      if (!trimmed) return { text: input.text, applied: false };
      // Deterministic stand-in for the real model's rewrite, so dev/tests can
      // observe the enhanced-vs-raw distinction without a network call.
      const style = input.context.style?.trim() || 'auto';
      return {
        text: `${trimmed} — rendered as cohesive ${style} cover art with a controlled palette and deliberate lighting`.slice(
          0,
          MAX_COVER_GUIDANCE_LENGTH,
        ),
        applied: true,
        ...(LISTENER_HINT.test(trimmed) ? { includesListener: true } : {}),
      };
    },

    async *streamAssistantReply(input: AssistantReplyInput) {
      const script = options.assistantScript;
      const toolResults: string[] = [];
      for (const call of script?.toolCalls ?? []) {
        const tool = input.tools.find((candidate) => candidate.name === call.name);
        if (!tool) throw new Error(`the mock's script calls a tool it was not given: ${call.name}`);
        toolResults.push(await tool.execute(tool.inputSchema.parse(call.input)));
      }
      const answer = script
        ? script.reply(toolResults)
        : `Mock answer to: ${input.messages.at(-1)?.content ?? ''}`;
      // Word by word, so a consumer sees a stream rather than one block.
      yield* answer.match(/\S+\s*/g) ?? [];
    },
  };
}
