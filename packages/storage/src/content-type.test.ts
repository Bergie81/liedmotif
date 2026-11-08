import { describe, expect, it } from 'vitest';
import {
  audioContentType,
  contentTypeForKey,
  DEFAULT_CONTENT_TYPE,
  extensionForContentType,
} from './content-type';

describe('contentTypeForKey', () => {
  it('maps known audio and image extensions case-insensitively', () => {
    expect(contentTypeForKey('tracks/u/t/original.mp3')).toBe('audio/mpeg');
    expect(contentTypeForKey('tracks/u/t/ORIGINAL.MP3')).toBe('audio/mpeg');
    expect(contentTypeForKey('covers/x.webp')).toBe('image/webp');
    expect(contentTypeForKey('covers/uploaded/u/x.JPG')).toBe('image/jpeg');
    expect(contentTypeForKey('covers/uploaded/u/x.jpeg')).toBe('image/jpeg');
    expect(contentTypeForKey('covers/placeholder.svg')).toBe('image/svg+xml');
  });

  it('falls back to the binary default for unknown or missing extensions', () => {
    expect(contentTypeForKey('imports/u/b.bin')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForKey('tracks/u/t/noext')).toBe(DEFAULT_CONTENT_TYPE);
  });

  it('ignores a dot in a parent directory and dotfiles', () => {
    expect(contentTypeForKey('tracks/a.mp3/original')).toBe(DEFAULT_CONTENT_TYPE);
    expect(contentTypeForKey('config/.gitignore')).toBe(DEFAULT_CONTENT_TYPE);
  });
});

describe('extensionForContentType', () => {
  it('maps known audio content types to their canonical extension', () => {
    expect(extensionForContentType('audio/mpeg')).toBe('mp3');
    expect(extensionForContentType('audio/mp4')).toBe('m4a');
    expect(extensionForContentType('audio/aac')).toBe('aac');
    expect(extensionForContentType('audio/ogg')).toBe('ogg');
    expect(extensionForContentType('audio/flac')).toBe('flac');
    expect(extensionForContentType('audio/wav')).toBe('wav');
  });

  it('is case-insensitive and ignores parameters and surrounding whitespace', () => {
    expect(extensionForContentType('Audio/MPEG; charset=binary')).toBe('mp3');
    expect(extensionForContentType('  audio/mp4 ')).toBe('m4a');
  });

  it('falls back to mp3 for a missing or unknown audio content type', () => {
    expect(extensionForContentType(null)).toBe('mp3');
    expect(extensionForContentType(undefined)).toBe('mp3');
    expect(extensionForContentType('')).toBe('mp3');
    expect(extensionForContentType('application/octet-stream')).toBe('mp3');
  });

  it('honors a caller-supplied fallback when the type is unknown', () => {
    expect(extensionForContentType('application/x-weird', 'bin')).toBe('bin');
  });
});

describe('audioContentType', () => {
  it('keeps a recognized audio type', () => {
    expect(audioContentType('audio/mpeg')).toBe('audio/mpeg');
    expect(audioContentType('audio/flac; charset=binary')).toBe('audio/flac');
    expect(audioContentType(' AUDIO/WAV ')).toBe('audio/wav');
  });

  it('maps anything off the audio set to mp3', () => {
    // The reason this function exists: a hostile or MITM'd provider response
    // must never be served back as markup in the app origin.
    expect(audioContentType('text/html')).toBe('audio/mpeg');
    expect(audioContentType('image/svg+xml')).toBe('audio/mpeg');
    expect(audioContentType('application/octet-stream')).toBe('audio/mpeg');
    expect(audioContentType(null)).toBe('audio/mpeg');
    expect(audioContentType('')).toBe('audio/mpeg');
  });

  it('canonicalizes the non-standard mp3 alias', () => {
    expect(audioContentType('audio/mp3')).toBe('audio/mpeg');
  });
});
