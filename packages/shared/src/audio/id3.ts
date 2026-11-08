// Minimal ID3v2 metadata reader/writer for locally stored final MP3s.
//
// Liedmotif embeds the Session's effective Cover (`APIC`), the core text frames
// (`TIT2` title / `TALB` album / `TPE1`+`TPE2` artist / `TCON` genre / `TYER`
// year / `TBPM` tempo), a vocal Track's lyrics (`USLT`), and `TXXX` user frames
// (generation provenance + the tag-state marker) into final MP3 files so shared
// or exported tracks stay self-contained in external players.
// Writing always emits a fresh ID3v2.3 tag (the broadly compatible revision) and
// REPLACES any existing v2 tag without touching the audio frames; reading
// understands v2.3 and v2.4 well enough for the idempotency check (a `TXXX`
// marker frame comparing what is already embedded). Dependency-free and
// Buffer-free (plain `Uint8Array`/`DataView`) so it lives in `@liedmotif/shared`
// like the other pure domain helpers.

/** Album art for the `APIC` frame. WebP is deliberately NOT accepted here —
 *  callers convert to a broadly compatible rendition (JPEG/PNG) first. */
export interface Id3Artwork {
  mediaType: 'image/jpeg' | 'image/png';
  bytes: Uint8Array;
}

/** The tag set Liedmotif embeds. Absent/empty fields write no frame. */
export interface Id3Tags {
  title?: string | null;
  album?: string | null;
  /** `TPE1` (and `TPE2` album artist, for player compatibility). */
  artist?: string | null;
  artwork?: Id3Artwork | null;
  /** Unsynchronized lyric text (`USLT`) — what external players show as Lyrics. */
  lyrics?: string | null;
  /** Content type (`TCON`) — callers pass a display string (e.g. genres joined `, `). */
  genre?: string | null;
  /** Release year (`TYER` — the v2.3 year frame, not the v2.4-only `TDRC`). */
  year?: number | null;
  /** Beats per minute (`TBPM`) — an integer frame, so the writer rounds. */
  bpm?: number | null;
  /** `TXXX` user frames keyed by description (e.g. the Liedmotif tag-state marker). */
  userText?: Record<string, string>;
}

/** What `readId3Tags` recovered from an existing ID3v2 tag. */
export interface ParsedId3Tags {
  title: string | null;
  album: string | null;
  artist: string | null;
  hasArtwork: boolean;
  /** The `USLT` lyric text, when one is embedded. */
  lyrics: string | null;
  genre: string | null;
  year: number | null;
  bpm: number | null;
  /** `TXXX` user frames keyed by description. */
  userText: Record<string, string>;
}

/** The `TXXX` description Liedmotif's tag-state marker is stored under. The
 *  embed job writes it with every tag set; its presence in a file's leading tag
 *  is the "this file has been tagged" signal the download routes probe for. */
export const LIEDMOTIF_TAG_MARKER = 'Liedmotif';

/** Fixed ID3v2 header size — also the prefix a ranged reader must hold to size
 *  the whole leading tag (see `id3v2TagLength`). */
export const ID3_HEADER_SIZE = 10;
const FRAME_HEADER_SIZE = 10;

/** 28-bit syncsafe integer (4 bytes, high bit of each byte clear). */
function readSyncsafe(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! & 0x7f) << 21) |
    ((bytes[offset + 1]! & 0x7f) << 14) |
    ((bytes[offset + 2]! & 0x7f) << 7) |
    (bytes[offset + 3]! & 0x7f)
  );
}

function writeSyncsafe(value: number): [number, number, number, number] {
  return [(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f];
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!)
  );
}

function hasId3v2Header(bytes: Uint8Array): boolean {
  return (
    bytes.length >= ID3_HEADER_SIZE &&
    bytes[0] === 0x49 && // 'I'
    bytes[1] === 0x44 && // 'D'
    bytes[2] === 0x33 && // '3'
    bytes[3]! < 0xff &&
    bytes[6]! < 0x80 &&
    bytes[7]! < 0x80 &&
    bytes[8]! < 0x80 &&
    bytes[9]! < 0x80
  );
}

/** Total byte length of the leading ID3v2 tag (0 when none), incl. any v2.4 footer.
 * Works from the first `ID3_HEADER_SIZE` bytes alone, so a caller holding only a
 * ranged prefix of the file can size a second ranged read that covers the whole
 * tag — the marker fast path that avoids reading a multi-MB MP3 to answer
 * "already tagged?". */
export function id3v2TagLength(bytes: Uint8Array): number {
  if (!hasId3v2Header(bytes)) return 0;
  const flags = bytes[5]!;
  const footer = (flags & 0x10) !== 0 ? ID3_HEADER_SIZE : 0;
  return ID3_HEADER_SIZE + readSyncsafe(bytes, 6) + footer;
}

/** The audio (and anything else) after the leading ID3v2 tag, or the input as-is. */
export function stripId3v2(bytes: Uint8Array): Uint8Array {
  const tagLength = id3v2TagLength(bytes);
  return tagLength > 0 ? bytes.subarray(Math.min(tagLength, bytes.length)) : bytes;
}

// --- Text codecs -----------------------------------------------------------------

function encodeLatin1(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i += 1) out[i] = value.charCodeAt(i) & 0xff;
  return out;
}

function isLatin1(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) if (value.charCodeAt(i) > 0xff) return false;
  return true;
}

/** UTF-16LE with BOM — ID3v2.3's unicode text encoding (encoding byte 0x01). */
function encodeUtf16WithBom(value: string): Uint8Array {
  const out = new Uint8Array(2 + value.length * 2);
  out[0] = 0xff;
  out[1] = 0xfe;
  for (let i = 0; i < value.length; i += 1) {
    const unit = value.charCodeAt(i);
    out[2 + i * 2] = unit & 0xff;
    out[3 + i * 2] = unit >>> 8;
  }
  return out;
}

function decodeUtf16(bytes: Uint8Array, littleEndianDefault: boolean): string {
  let start = 0;
  let littleEndian = littleEndianDefault;
  if (bytes.length >= 2) {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
      littleEndian = true;
      start = 2;
    } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
      littleEndian = false;
      start = 2;
    }
  }
  let out = '';
  for (let i = start; i + 1 < bytes.length; i += 2) {
    out += String.fromCharCode(
      littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!,
    );
  }
  return out;
}

function decodeLatin1(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** Decode a text payload by its ID3 encoding byte, trimming trailing NULs. */
function decodeText(encoding: number, bytes: Uint8Array): string {
  let text: string;
  if (encoding === 1) text = decodeUtf16(bytes, true);
  else if (encoding === 2) text = decodeUtf16(bytes, false);
  else if (encoding === 3) text = new TextDecoder('utf-8').decode(bytes);
  else text = decodeLatin1(bytes);
  return text.replace(/\0+$/, '');
}

/** Byte length of a NUL string terminator in the frame's encoding (UTF-16 needs a full unit). */
function terminatorSize(latin1: boolean): number {
  return latin1 ? 1 : 2;
}

/** Index just past the encoding-appropriate NUL terminator, or -1 when unterminated. */
function terminatorEnd(bytes: Uint8Array, start: number, encoding: number): number {
  if (encoding === 1 || encoding === 2) {
    for (let i = start; i + 1 < bytes.length; i += 2) {
      if (bytes[i] === 0 && bytes[i + 1] === 0) return i + 2;
    }
    return -1;
  }
  for (let i = start; i < bytes.length; i += 1) if (bytes[i] === 0) return i + 1;
  return -1;
}

// --- Reading -----------------------------------------------------------------

/**
 * Parse the leading ID3v2.3/v2.4 tag of an MP3 into the fields Liedmotif cares
 * about. Returns `null` when there is no tag, or when the tag uses a layout this
 * minimal parser does not read (v2.2, unsynchronised) — callers treat that the
 * same as "not tagged by us" and re-embed.
 */
export function readId3Tags(bytes: Uint8Array): ParsedId3Tags | null {
  if (!hasId3v2Header(bytes)) return null;
  const major = bytes[3]!;
  const flags = bytes[5]!;
  // v2.2 frames (3-byte ids) and unsynchronised tags are not parsed; the writer
  // replaces them wholesale via `stripId3v2` either way.
  if (major < 3 || major > 4 || (flags & 0x80) !== 0) return null;

  const tagEnd = Math.min(ID3_HEADER_SIZE + readSyncsafe(bytes, 6), bytes.length);
  let pos = ID3_HEADER_SIZE;
  if ((flags & 0x40) !== 0 && pos + 4 <= tagEnd) {
    // Skip the extended header: v2.3 stores its size EXCLUDING the size field,
    // v2.4 a syncsafe size INCLUDING it.
    pos += major === 3 ? 4 + readUint32(bytes, pos) : readSyncsafe(bytes, pos);
  }

  const parsed: ParsedId3Tags = {
    title: null,
    album: null,
    artist: null,
    hasArtwork: false,
    lyrics: null,
    genre: null,
    year: null,
    bpm: null,
    userText: {},
  };

  while (pos + FRAME_HEADER_SIZE <= tagEnd) {
    if (bytes[pos] === 0) break; // padding
    const id = decodeLatin1(bytes.subarray(pos, pos + 4));
    const size = major === 4 ? readSyncsafe(bytes, pos + 4) : readUint32(bytes, pos + 4);
    const frameStart = pos + FRAME_HEADER_SIZE;
    const frameEnd = frameStart + size;
    if (size <= 0 || frameEnd > tagEnd) break; // corrupt frame — stop parsing
    const payload = bytes.subarray(frameStart, frameEnd);

    if (id === 'APIC') {
      parsed.hasArtwork = true;
    } else if (id === 'USLT' && payload.length > 4) {
      // encoding byte + 3-byte language, then a terminated content descriptor
      // and the lyric text itself (both in the frame's encoding).
      const encoding = payload[0]!;
      const descriptorEnd = terminatorEnd(payload, 4, encoding);
      if (descriptorEnd > 0) parsed.lyrics = decodeText(encoding, payload.subarray(descriptorEnd));
    } else if (id === 'TXXX' && payload.length > 1) {
      const encoding = payload[0]!;
      const descriptionEnd = terminatorEnd(payload, 1, encoding);
      if (descriptionEnd > 0) {
        // `decodeText` already trims trailing NULs, so the description is clean.
        const description = decodeText(encoding, payload.subarray(1, descriptionEnd));
        parsed.userText[description] = decodeText(encoding, payload.subarray(descriptionEnd));
      }
    } else if (id[0] === 'T' && payload.length > 1) {
      const text = decodeText(payload[0]!, payload.subarray(1));
      if (id === 'TIT2') parsed.title = text;
      else if (id === 'TALB') parsed.album = text;
      else if (id === 'TPE1') parsed.artist = text;
      else if (id === 'TCON') parsed.genre = text;
      else if (id === 'TYER') parsed.year = Number.isFinite(Number(text)) ? Number(text) : null;
      else if (id === 'TBPM') parsed.bpm = Number.isFinite(Number(text)) ? Number(text) : null;
    }
    pos = frameEnd;
  }
  return parsed;
}

// --- Writing -----------------------------------------------------------------

function frame(id: string, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(FRAME_HEADER_SIZE + payload.length);
  out.set(encodeLatin1(id), 0);
  const size = payload.length;
  out[4] = (size >>> 24) & 0xff;
  out[5] = (size >>> 16) & 0xff;
  out[6] = (size >>> 8) & 0xff;
  out[7] = size & 0xff;
  // Frame flags stay 0; payload follows the 10-byte header.
  out.set(payload, FRAME_HEADER_SIZE);
  return out;
}

/** A `T***` text frame: latin1 when it suffices, UTF-16+BOM otherwise (v2.3). */
function textFrame(id: string, value: string): Uint8Array {
  const latin1 = isLatin1(value);
  const encoded = latin1 ? encodeLatin1(value) : encodeUtf16WithBom(value);
  const payload = new Uint8Array(1 + encoded.length);
  payload[0] = latin1 ? 0 : 1;
  payload.set(encoded, 1);
  return frame(id, payload);
}

/** A `TXXX` user text frame (`description` NUL `value`). */
function userTextFrame(description: string, value: string): Uint8Array {
  const latin1 = isLatin1(description) && isLatin1(value);
  const encodedDescription = latin1 ? encodeLatin1(description) : encodeUtf16WithBom(description);
  const encodedValue = latin1 ? encodeLatin1(value) : encodeUtf16WithBom(value);
  // encoding byte + terminated description; the terminator stays zero-filled.
  const valueStart = 1 + encodedDescription.length + terminatorSize(latin1);
  const payload = new Uint8Array(valueStart + encodedValue.length);
  payload[0] = latin1 ? 0 : 1;
  payload.set(encodedDescription, 1);
  payload.set(encodedValue, valueStart);
  return frame('TXXX', payload);
}

/** A `USLT` unsynchronized-lyrics frame (language `und`, empty descriptor). */
function lyricsFrame(lyrics: string): Uint8Array {
  const latin1 = isLatin1(lyrics);
  const encoded = latin1 ? encodeLatin1(lyrics) : encodeUtf16WithBom(lyrics);
  // encoding byte + 3-byte language + an empty (zero-filled) content descriptor.
  const textStart = 1 + 3 + terminatorSize(latin1);
  const payload = new Uint8Array(textStart + encoded.length);
  payload[0] = latin1 ? 0 : 1;
  payload.set(encodeLatin1('und'), 1); // language: undetermined
  payload.set(encoded, textStart);
  return frame('USLT', payload);
}

/** An `APIC` front-cover frame (picture type 0x03, empty description). */
function artworkFrame(artwork: Id3Artwork): Uint8Array {
  const mime = encodeLatin1(artwork.mediaType);
  const payload = new Uint8Array(1 + mime.length + 1 + 1 + 1 + artwork.bytes.length);
  let pos = 0;
  payload[pos] = 0; // latin1 description
  pos += 1;
  payload.set(mime, pos);
  pos += mime.length;
  payload[pos] = 0; // mime terminator
  pos += 1;
  payload[pos] = 0x03; // picture type: front cover
  pos += 1;
  payload[pos] = 0; // empty description terminator
  pos += 1;
  payload.set(artwork.bytes, pos);
  return frame('APIC', payload);
}

/**
 * Render a complete, standalone ID3v2.3 tag (header + frames) carrying `tags`,
 * or null when no field writes a frame. This is exactly the leading tag
 * `embedId3Tags` prepends — exposed so a caller can stream `tag ++ audio body`
 * without ever holding the whole MP3 in memory.
 */
export function buildId3Tag(tags: Id3Tags): Uint8Array | null {
  const frames: Uint8Array[] = [];
  if (tags.title?.trim()) frames.push(textFrame('TIT2', tags.title.trim()));
  if (tags.album?.trim()) frames.push(textFrame('TALB', tags.album.trim()));
  if (tags.artist?.trim()) {
    frames.push(textFrame('TPE1', tags.artist.trim()));
    // Album artist mirrors the artist for players that group albums by TPE2.
    frames.push(textFrame('TPE2', tags.artist.trim()));
  }
  // Trim only the OUTER whitespace (matching the T*** frames) — the internal
  // line breaks ARE the lyric structure and ship verbatim.
  if (tags.lyrics?.trim()) frames.push(lyricsFrame(tags.lyrics.trim()));
  if (tags.genre?.trim()) frames.push(textFrame('TCON', tags.genre.trim()));
  if (tags.year != null) frames.push(textFrame('TYER', String(tags.year)));
  if (tags.bpm != null) frames.push(textFrame('TBPM', String(Math.round(tags.bpm))));
  for (const [description, value] of Object.entries(tags.userText ?? {})) {
    frames.push(userTextFrame(description, value));
  }
  if (tags.artwork) frames.push(artworkFrame(tags.artwork));
  if (frames.length === 0) return null;

  const framesLength = frames.reduce((sum, f) => sum + f.length, 0);
  const out = new Uint8Array(ID3_HEADER_SIZE + framesLength);
  out.set(encodeLatin1('ID3'), 0);
  out[3] = 3; // ID3v2.3
  out[4] = 0;
  out[5] = 0; // no flags
  out.set(writeSyncsafe(framesLength), 6);
  let pos = ID3_HEADER_SIZE;
  for (const f of frames) {
    out.set(f, pos);
    pos += f.length;
  }
  return out;
}

/**
 * Replace the MP3's ID3v2 tag with a fresh v2.3 tag carrying `tags`. The audio
 * frames after any existing tag are preserved byte-for-byte; fields that are
 * absent or blank write no frame.
 */
export function embedId3Tags(audio: Uint8Array, tags: Id3Tags): Uint8Array {
  const tag = buildId3Tag(tags);
  const body = stripId3v2(audio);
  if (!tag) {
    // Nothing to embed → just drop any existing tag.
    return body === audio ? audio : body.slice();
  }
  const out = new Uint8Array(tag.length + body.length);
  out.set(tag, 0);
  out.set(body, tag.length);
  return out;
}
