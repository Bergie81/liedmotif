// The Offline Library: a static page with no server data and no sign-in, so the
// service worker can cache it and show it when a page navigation fails for want
// of a network. Everything on it is read from the device in the browser.

import { OfflineLibrary } from '@/components/offline/offline-library';

export const dynamic = 'force-static';

export default function OfflineLibraryPage() {
  return <OfflineLibrary />;
}
