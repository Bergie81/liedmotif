// Which source paints a Session's generated Cover. This is one
// rule, so it lives in one place and every caller asks here rather than
// re-deriving it. The worker answers the same question against real provider
// objects in `resolveSessionCoverImageProvider`; this is that decision expressed
// over what the web process can see.

export type CoverSource = 'image' | 'music-provider' | 'none';

/**
 * The image model paints a TAILORED cover around the Session and its People, or
 * the music provider draws one from the music alone. The image model needs both
 * a configured provider and the owner's switch, so the switch alone cannot
 * decide the outcome; the music provider takes over whenever the image model is
 * off or absent. `none` is not a third source: it says no generated cover is
 * coming at all, so Sessions keep the built-in branded placeholder.
 */
export function coverSource(input: {
  imageProviderConfigured: boolean;
  tailoredCoverArtEnabled: boolean;
  musicProviderCoverConfigured: boolean;
}): CoverSource {
  if (input.imageProviderConfigured && input.tailoredCoverArtEnabled) return 'image';
  return input.musicProviderCoverConfigured ? 'music-provider' : 'none';
}
