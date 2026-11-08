import type { MetadataRoute } from 'next';

// PWA manifest for Android Chrome install. The PNG entries (192/512 `any` plus
// a 512 `maskable`) are what WebAPK minting requires; the SVG entry is the
// scalable icon for capable browsers. Regenerate the PNGs from the SVG mark
// with `npm run icons:generate`.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Liedmotif',
    short_name: 'Liedmotif',
    description: 'Self-hosted, source-available AI music sessions.',
    start_url: '/',
    display: 'standalone',
    // Android WebAPKs bake this in at install time: the installed app never
    // follows the device into landscape. iOS ignores the member entirely and
    // exposes no lock API, so `.portrait-guard` covers that case in CSS.
    orientation: 'portrait',
    background_color: '#09090b',
    theme_color: '#09090b',
    icons: [
      {
        src: '/icon.svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any',
      },
      {
        src: '/icons/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icons/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
