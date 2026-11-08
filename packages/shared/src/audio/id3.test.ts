import { describe, expect, it } from 'vitest';
import { buildId3Tag, embedId3Tags, readId3Tags, stripId3v2, type Id3Tags } from './id3';

/** A tiny fake MP3 body: an MPEG frame sync followed by junk audio bytes. */
function fakeAudio(): Uint8Array {
  const audio = new Uint8Array(64);
  audio[0] = 0xff;
  audio[1] = 0xfb;
  for (let i = 2; i < audio.length; i += 1) audio[i] = i & 0xff;
  return audio;
}

const TAGS: Id3Tags = {
  title: 'Rainfall Circuit',
  album: 'Deep Focus Coding',
  artist: 'John',
  userText: { Liedmotif: 'cover:abc|v1' },
  artwork: { mediaType: 'image/jpeg', bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]) },
};

describe('embedId3Tags / readId3Tags', () => {
  it('round-trips title, album, artist, user text, and artwork presence', () => {
    const tagged = embedId3Tags(fakeAudio(), TAGS);
    const parsed = readId3Tags(tagged);
    expect(parsed).not.toBeNull();
    expect(parsed!.title).toBe('Rainfall Circuit');
    expect(parsed!.album).toBe('Deep Focus Coding');
    expect(parsed!.artist).toBe('John');
    expect(parsed!.userText.Liedmotif).toBe('cover:abc|v1');
    expect(parsed!.hasArtwork).toBe(true);
  });

  it('preserves the audio bytes exactly after the tag', () => {
    const audio = fakeAudio();
    const tagged = embedId3Tags(audio, TAGS);
    expect(stripId3v2(tagged)).toEqual(audio);
  });

  it('replaces an existing tag instead of stacking a second one', () => {
    const audio = fakeAudio();
    const once = embedId3Tags(audio, TAGS);
    const twice = embedId3Tags(once, { ...TAGS, title: 'Retitled' });
    expect(readId3Tags(twice)!.title).toBe('Retitled');
    expect(stripId3v2(twice)).toEqual(audio);
  });

  it('decomposes exactly: embedId3Tags equals buildId3Tag ++ stripped audio, tagged and untagged', () => {
    // The streamed rewrite relies on this identity — it writes
    // `buildId3Tag(tags)` then streams the bytes after the old tag, and must
    // produce the same file the buffered path would.
    const untagged = fakeAudio();
    const alreadyTagged = embedId3Tags(untagged, { ...TAGS, title: 'Older Title' });
    for (const fixture of [untagged, alreadyTagged]) {
      const tag = buildId3Tag(TAGS)!;
      const body = stripId3v2(fixture);
      const expected = new Uint8Array(tag.length + body.length);
      expected.set(tag, 0);
      expected.set(body, tag.length);
      expect(embedId3Tags(fixture, TAGS)).toEqual(expected);
    }
  });

  it('is byte-identical when re-embedding identical tags (idempotent rewrite)', () => {
    const once = embedId3Tags(fakeAudio(), TAGS);
    const again = embedId3Tags(once, TAGS);
    expect(again).toEqual(once);
  });

  it('round-trips non-latin1 text via UTF-16', () => {
    const tagged = embedId3Tags(fakeAudio(), { title: 'Käfer im Regen — 夜', artist: 'Zoë' });
    const parsed = readId3Tags(tagged)!;
    expect(parsed.title).toBe('Käfer im Regen — 夜');
    expect(parsed.artist).toBe('Zoë');
  });

  it('round-trips lyrics as a USLT frame (latin1 and UTF-16 alike)', () => {
    const plain = embedId3Tags(fakeAudio(), { ...TAGS, lyrics: '[Verse]\nRain on the window' });
    expect(readId3Tags(plain)!.lyrics).toBe('[Verse]\nRain on the window');

    const unicode = '[Strophe]\nSpät in Berlin, nur dein Tisch.\nDu bist still — schon bereit.';
    const parsed = readId3Tags(embedId3Tags(fakeAudio(), { ...TAGS, lyrics: unicode }))!;
    expect(parsed.lyrics).toBe(unicode);
    // The other frames survive alongside the lyrics.
    expect(parsed.title).toBe(TAGS.title);
    expect(parsed.hasArtwork).toBe(true);
  });

  it('trims outer whitespace from lyrics but ships internal line breaks verbatim', () => {
    const tagged = embedId3Tags(fakeAudio(), {
      ...TAGS,
      lyrics: '\n [Verse]\nLine one\n\nLine two \n',
    });
    expect(readId3Tags(tagged)!.lyrics).toBe('[Verse]\nLine one\n\nLine two');
  });

  it('writes no USLT frame for absent or blank lyrics', () => {
    expect(readId3Tags(embedId3Tags(fakeAudio(), TAGS))!.lyrics).toBeNull();
    expect(readId3Tags(embedId3Tags(fakeAudio(), { ...TAGS, lyrics: '  ' }))!.lyrics).toBeNull();
  });

  it('round-trips genre, year, and bpm as TCON/TYER/TBPM', () => {
    const tagged = embedId3Tags(fakeAudio(), {
      ...TAGS,
      genre: 'Lo-fi, Ambient',
      year: 2026,
      bpm: 87.6,
    });
    const parsed = readId3Tags(tagged)!;
    expect(parsed.genre).toBe('Lo-fi, Ambient');
    expect(parsed.year).toBe(2026);
    // TBPM is an integer frame — the writer rounds.
    expect(parsed.bpm).toBe(88);
    // The pre-existing frames survive alongside the new ones.
    expect(parsed.title).toBe(TAGS.title);
    expect(parsed.hasArtwork).toBe(true);
  });

  it('writes no TCON/TYER/TBPM frame for absent fields', () => {
    const parsed = readId3Tags(embedId3Tags(fakeAudio(), TAGS))!;
    expect(parsed.genre).toBeNull();
    expect(parsed.year).toBeNull();
    expect(parsed.bpm).toBeNull();
  });

  it('omits frames for blank fields and returns null-ish fields on read', () => {
    const tagged = embedId3Tags(fakeAudio(), { title: 'Only title', album: '  ', artist: null });
    const parsed = readId3Tags(tagged)!;
    expect(parsed.title).toBe('Only title');
    expect(parsed.album).toBeNull();
    expect(parsed.artist).toBeNull();
    expect(parsed.hasArtwork).toBe(false);
  });

  it('returns null for untagged audio and strips nothing from it', () => {
    const audio = fakeAudio();
    expect(readId3Tags(audio)).toBeNull();
    expect(stripId3v2(audio)).toBe(audio);
  });

  it('drops an existing tag when there is nothing to embed', () => {
    const audio = fakeAudio();
    const tagged = embedId3Tags(audio, TAGS);
    expect(embedId3Tags(tagged, {})).toEqual(audio);
  });
});
