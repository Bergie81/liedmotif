// `readTrack`: one Track the asking user can hear, as the Track Data and
// Lyrics sheets show it. It reads through the same queries those sheets use,
// so it sees the asker's own Tracks and the ones in the Lounge for them, and
// nothing vendor-secret. Lyrics are what is stored: it never asks the music
// provider for missing ones, so it writes nothing and spends nothing.

import {
  getReadableTrackDetails,
  getReadableTrackLyricsContext,
  getUsageLimits,
} from '@liedmotif/db';
import type { LlmTool } from '@liedmotif/providers';
import { readTrackInputSchema, type ReadTrackInput, type VocalMode } from '@liedmotif/shared';
import { buildTrackDataSections, type TrackDataLabels } from '@/components/player/track-data-view';
import { NO_SUCH_TRACK, NO_TRACK_PLAYING } from './library-action';
import { named } from './music-names';
import { isId } from './readable-music';
import { READ_TRACK_TOOL_NAME } from './tool-names';
import type { AssistantAsker } from './tools';

/** The sheet's labels speak to the listener; the model is told the app's own terms instead. */
const LABELS_FOR_MODEL: TrackDataLabels = { session: 'Session', userPrompt: "User's prompt" };

function lyricsLine(vocalMode: VocalMode, lyrics: string | null | undefined): string {
  if (lyrics) return `Lyrics:\n${lyrics}`;
  return vocalMode === 'vocal'
    ? 'Lyrics: none stored for this Track.'
    : 'Lyrics: none, it is instrumental.';
}

export function createReadTrackTool(asker: AssistantAsker): LlmTool<ReadTrackInput> {
  const { db, userId, player } = asker;
  return {
    name: READ_TRACK_TOOL_NAME,
    description:
      'One Track\'s Track Data and its lyrics: title, Session, artist, when it was generated, the user\'s prompt, the style prompt the music model received, genres, mood, energy, vocals, BPM, model, and the stored lyrics. Leave out trackId for the Track that is playing now ("this").',
    inputSchema: readTrackInputSchema,
    async execute({ trackId: given }) {
      const trackId = given || player?.trackId;
      if (!trackId) return NO_TRACK_PLAYING;
      if (!isId(trackId)) return NO_SUCH_TRACK;
      const read = { viewerUserId: userId, trackId };
      const [details, lyrics, { resetTimezone }] = await Promise.all([
        getReadableTrackDetails(db, read),
        getReadableTrackLyricsContext(db, read),
        getUsageLimits(db),
      ]);
      if (!details) return NO_SUCH_TRACK;
      const sections = buildTrackDataSections(
        {
          ...details,
          createdAt: details.createdAt.toISOString(),
          timezone: resetTimezone,
          bpm: details.bpmEstimate != null ? Math.round(details.bpmEstimate) : null,
        },
        LABELS_FOR_MODEL,
      );
      return [
        `Track ${named(details.title, trackId)}`,
        ...sections.flatMap(({ fields }) => fields.map(({ label, value }) => `${label}: ${value}`)),
        lyricsLine(details.vocalMode, lyrics?.lyrics),
      ].join('\n');
    },
  };
}
