// Server-side image processing shared by the worker (generated cover artwork,
// ID3 album art) and the web app (uploaded avatars, covers, reference photos,
// ID3 album art on download). Everything here needs `sharp`, so it must never be
// imported from a client component.

export {
  configureSharpConcurrency,
  detectImageFormat,
  MAX_DECODE_PIXELS,
  openImage,
} from './image-decode';
export {
  AlbumArtCache,
  loadAlbumArt,
  renderAlbumArt,
  type AlbumArtSource,
  type RenderAlbumArt,
} from './album-art';
export {
  COVER_WEBP_QUALITY,
  NORMALIZED_COVER_EDGE,
  evaluateCoverImage,
  measureImageDimensions,
  normalizeCoverImageToWebp,
  renderCoverThumbnail,
  type CoverQualityVerdict,
  type EvaluateCoverImage,
  type MeasureImage,
  type NormalizeCoverImage,
} from './cover-quality';
