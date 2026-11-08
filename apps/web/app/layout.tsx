import type { Metadata, Viewport } from 'next';
import { Bricolage_Grotesque, Instrument_Sans, Space_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { PortraitGuard } from '@/components/portrait-guard';
import { TooltipProvider } from '@/components/ui/tooltip';
import './globals.css';

const displayFont = Bricolage_Grotesque({
  subsets: ['latin'],
  variable: '--font-display-face',
  display: 'swap',
});

const bodyFont = Instrument_Sans({
  subsets: ['latin'],
  variable: '--font-body-face',
  display: 'swap',
});

const monoFont = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono-face',
  display: 'swap',
  // Small labels only — keep both weights out of the render-blocking preload set.
  preload: false,
});

export const metadata: Metadata = {
  title: 'Liedmotif',
  description: 'Self-hosted, source-available AI music sessions.',
  applicationName: 'Liedmotif',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Liedmotif',
  },
};

// Mobile-first viewport: device width, no forced zoom, cover the notch area.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  // Media-specific entries, not a single value: Chrome on Android ignores a
  // bare theme-color in installed PWAs when the device is in dark theme
  // (crbug 40634649), but consults scheme-qualified variants. The app renders
  // dark chrome in both OS themes, so both entries carry the dark color.
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0f0d16' },
    { media: '(prefers-color-scheme: light)', color: '#0f0d16' },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootstrapScript }} />
      </head>
      <body>
        {/* One provider for the whole app: Radix shares the open/skip timers
            across its descendants, so moving between adjacent icon buttons
            shows the second tip immediately instead of re-waiting. */}
        <TooltipProvider delayDuration={350} skipDelayDuration={300}>
          {children}
        </TooltipProvider>
        <PortraitGuard />
      </body>
    </html>
  );
}

const themeBootstrapScript = `
try {
  var saved = localStorage.getItem('liedmotif-theme');
  // Dark (night) is the default; light is an explicit user choice only.
  document.documentElement.classList.toggle('light', saved === 'light');
  document.documentElement.classList.toggle('rail-expanded', localStorage.getItem('liedmotif-rail-expanded') === 'true');
} catch (_) {}
`;
