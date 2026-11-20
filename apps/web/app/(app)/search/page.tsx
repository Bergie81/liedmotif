import { SearchView } from '@/components/search/search-view';
import { searchStateFromParams } from '@/components/search/search-model';
import { displayHeadingClass } from '@/components/ui/design-system';
import { requireAppAccess } from '@/lib/auth/session';

export default async function SearchPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const initialState = searchStateFromParams(await searchParams);
  // Recent searches are browser-local but scoped to the signed-in account.
  const { session } = await requireAppAccess();
  return (
    <>
      <header>
        <h1 className={`${displayHeadingClass} mb-2`}>Find Anything You Made</h1>
        <p className="text-[14.5px] text-muted">
          Find any session, track or playlist by name, tag or the prompt behind it. Remember a line
          from a song? Turn on Search Lyrics.
        </p>
      </header>
      <SearchView initialState={initialState} userId={session.user.id} />
    </>
  );
}
