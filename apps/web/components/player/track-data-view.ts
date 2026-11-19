// View-model for the Track Data sheet: shape one `TrackDetails` payload into
// labeled display sections. Absent values write no field and an empty section
// disappears entirely — the sheet never shows an empty label.

import type { TrackDetails } from '@liedmotif/shared';
import { formatPlayerTime } from './player-time';

export interface TrackDataField {
  label: string;
  value: string;
  /** Long free text (the prompts): rendered as a wrapping block, not an inline row. */
  block?: boolean;
}

export interface TrackDataSection {
  title: string;
  fields: TrackDataField[];
}

/**
 * The day in the Instance timezone the payload carries, so server and client
 * render the same text. Track Data kept offline without one is shown as the
 * UTC day, labelled so it never reads as a second unlabelled calendar.
 */
function formatGeneratedDate(iso: string, timeZone: string | undefined): string {
  const day = new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: timeZone ?? 'UTC',
  });
  return timeZone ? day : `${day} UTC`;
}

/** The Vocals field: the Track's mode, with the sung language when known. */
function presentVocalMode(details: TrackDetails): string {
  if (details.vocalMode !== 'vocal') return 'Instrumental';
  return details.language ? `Vocal · ${details.language}` : 'Vocal';
}

function field(label: string, value: string | null, block?: boolean): TrackDataField[] {
  if (!value?.trim()) return [];
  return [{ label, value, ...(block ? { block } : {}) }];
}

export function buildTrackDataSections(details: TrackDetails): TrackDataSection[] {
  const sections: TrackDataSection[] = [
    {
      title: 'Identity',
      fields: [
        ...field('Title', details.title),
        ...field('Album', details.sessionTitle),
        ...field('Artist', details.artistName),
        ...field('Generated', formatGeneratedDate(details.createdAt, details.timezone)),
        ...field(
          'Duration',
          details.durationSeconds != null ? formatPlayerTime(details.durationSeconds) : null,
        ),
      ],
    },
    {
      title: 'Prompts',
      fields: [
        ...field('Your prompt', details.userPrompt, true),
        ...field('Style prompt', details.stylePrompt, true),
        ...field('Expanded prompt', details.expandedPrompt, true),
      ],
    },
    {
      title: 'Vibe',
      fields: [
        ...field('Genres', details.genreTags.join(', ')),
        ...field('Activity', details.activity),
        ...field('Mood', details.mood),
        ...field('Energy', details.energy),
        ...field('Vocals', presentVocalMode(details)),
        ...field('BPM', details.bpm != null ? String(details.bpm) : null),
      ],
    },
    {
      title: 'Provenance',
      fields: [
        ...field('Provider', details.providerKey),
        ...field('Model', details.providerModel),
        ...field('License', details.licenseNote),
      ],
    },
  ];
  return sections.filter((section) => section.fields.length > 0);
}
