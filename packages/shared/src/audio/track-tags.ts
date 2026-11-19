// The one definition of a Track's ID3 tag set: which frames a final MP3 carries
// (title/album/artist/genre/year/BPM, the Session's effective Cover as `APIC`, a
// vocal Track's lyrics as `USLT`, generation provenance as `TXXX`) and the
// marker frame that identifies that exact set.
//
// The worker's `embed-track-metadata` job writes these tags into the stored
// file; the download routes compare the marker against the stored file's leading
// tag to decide whether those bytes still carry current truth. Because both go
// through here, "the tags are current" cannot mean two different things.

import { hash32 } from '../hash';
import { buildId3Tag, LIEDMOTIF_TAG_MARKER, type Id3Artwork, type Id3Tags } from './id3';

/** `TXXX:Generator` — the one frame naming the app (never the artist frames). */
const GENERATOR_NAME = 'Liedmotif';

/** Everything a Track's tags are assembled from, plus the file they describe.
 *  Session-derived fields are nullable: a Track can outlive its Session and
 *  still deserves its text frames. */
export interface TrackTagContext {
  trackId: string;
  trackTitle: string | null;
  sessionTitle: string | null;
  /** The Session's effective cover (generated preferred by pointer), if any.
   *  `branded` says whether its STORED bytes already carry the brand badge —
   *  the rendition composites one at embed time exactly when they do not. */
  cover: { coverImageId: string; storageKey: string; branded: boolean } | null;
  /** The resolved artist: profile Artist Name, else the User name. */
  artist: string;
  /** The captured sung lyrics (`USLT`); null for instrumental / not-yet-captured. */
  lyrics: string | null;
  /** The track's own genre tags (`TCON`). */
  genreTags: string[];
  /** When the track was generated (`TYER`). */
  trackCreatedAt: Date;
  /** Tempo measured from the audio (`TBPM`); null until the analysis lands, and
   *  for a tempo that is only an estimate. */
  measuredBpm: number | null;
  /** The prompt history frozen when this Track was generated (`TXXX:Prompt`). */
  userPrompt: string | null;
  /** What the music model actually received (`TXXX:StylePrompt`). */
  stylePrompt: string | null;
  /** Provider model version (`TXXX:Model`). */
  providerModel: string | null;
  /** Rights note (`TXXX:License`). */
  licenseNote: string | null;
  /** The local final MP3 these tags belong in. */
  audio: { storageKey: string; mimeType: string | null; byteSize: number | null };
}

/** The assembled tag set and its identity. */
export interface TrackTagPlan {
  /** Every frame except `APIC` and the marker — `buildTrackTag` adds those. */
  tags: Id3Tags;
  /** Identifies this exact tag set (see `tagStateMarker`). */
  marker: string;
  /** The cover to render into `APIC`, if the Session has one. */
  cover: { coverImageId: string; storageKey: string; branded: boolean } | null;
}

/**
 * The tag-state identity: a hash of the EXACT tag set (normalized the way the
 * writer normalizes, artwork riding as the cover image id) — so a file needs
 * re-tagging exactly when a written frame would change, and a frame added to
 * the assembly later is covered here for free. The leading version is part of
 * the marker, so a file tagged under an older marker format retags exactly once.
 */
function tagStateMarker(coverImageId: string | null, tags: Id3Tags): string {
  const state = JSON.stringify({
    coverImageId,
    // Trimmed/rounded like the written frames, so a whitespace-only field or a
    // sub-integer BPM re-measure never causes a retag.
    title: tags.title?.trim() || null,
    album: tags.album?.trim() || null,
    artist: tags.artist?.trim() || null,
    lyrics: tags.lyrics?.trim() || null,
    genre: tags.genre?.trim() || null,
    year: tags.year ?? null,
    bpm: tags.bpm != null ? Math.round(tags.bpm) : null,
    userText: tags.userText ?? {},
  });
  return `v3:${hash32(state)}`;
}

/** Resolve a track's current tag set and its marker from database context. */
export function assembleTrackTags(context: TrackTagContext): TrackTagPlan {
  // Empty `TXXX` provenance entries are dropped here so no empty frames are
  // written (the Generator constant and, later, the marker always ride along).
  const provenance = {
    Prompt: context.userPrompt,
    StylePrompt: context.stylePrompt,
    Model: context.providerModel,
    Generator: GENERATOR_NAME,
    License: context.licenseNote,
  };
  const userText: Record<string, string> = {};
  for (const [description, value] of Object.entries(provenance)) {
    if (value?.trim()) userText[description] = value.trim();
  }

  const tags: Id3Tags = {
    title: context.trackTitle,
    album: context.sessionTitle,
    artist: context.artist,
    lyrics: context.lyrics,
    genre: context.genreTags.join(', '),
    year: context.trackCreatedAt.getFullYear(),
    bpm: context.measuredBpm,
    userText,
  };
  return {
    tags,
    marker: tagStateMarker(context.cover?.coverImageId ?? null, tags),
    cover: context.cover,
  };
}

/**
 * The complete leading tag for a plan: its frames, the artwork when one could be
 * rendered, and the marker that names this tag state. Never null — the Generator
 * constant and the marker always write a frame.
 */
export function buildTrackTag(plan: TrackTagPlan, artwork: Id3Artwork | null): Uint8Array {
  return buildId3Tag({
    ...plan.tags,
    artwork,
    userText: { ...plan.tags.userText, [LIEDMOTIF_TAG_MARKER]: plan.marker },
  })!;
}
