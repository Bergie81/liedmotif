/** The current Track's genres and, in a Session, its vocals. The line holds its
 *  height when it has neither, so the controls below stay put when pressing Play
 *  brings the genres in. */
export function TrackMetaLine({
  genres,
  vocals,
}: {
  genres?: string | null;
  vocals?: string | null;
}) {
  return (
    <div className="mt-4 flex min-h-[1lh] flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] uppercase tracking-[0.08em] text-muted">
      {genres ? <span data-testid="track-genres">{genres}</span> : null}
      {vocals ? (
        <>
          {genres ? <span className="text-dim">·</span> : null}
          <span data-testid="track-vocals">{vocals}</span>
        </>
      ) : null}
    </div>
  );
}
