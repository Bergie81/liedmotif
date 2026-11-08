/**
 * Guards audio resources (AudioContext, decoded buffers) whose construction is
 * costly and whose teardown is audible, against React's StrictMode
 * mount → unmount → remount probe: the probe's cleanup and the remount's bind
 * happen in the same task, so disposal is deferred by one microtask and skipped
 * when a newer bind claimed the resources meanwhile. A real unmount has no
 * newer bind, so it disposes.
 */
export class AudioResourceLifetime {
  private revision = 0;

  constructor(private readonly dispose: () => void) {}

  /** Claim the resources for this mount; the returned cleanup releases them. */
  bind(): () => void {
    const revision = ++this.revision;
    let released = false;

    return () => {
      if (released) return;
      released = true;

      queueMicrotask(() => {
        if (this.revision === revision) this.dispose();
      });
    };
  }
}
