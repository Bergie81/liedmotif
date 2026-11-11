const FLICK_DISTANCE_PX = 24;
const FLICK_VELOCITY_PX_PER_MS = 0.5;
/** A pointer held still fires no `pointermove`, so the last sample's speed
 *  goes stale: a release this long after it is no longer a flick. */
const FLICK_STALE_MS = 100;

/** One axis of a pointer drag. A release commits once the drag is long enough,
 *  or on a flick: a short drag still moving fast in the direction it went. */
export class DragAxis {
  private last: number;
  private lastTime: number;
  private velocity = 0;

  constructor(
    readonly start: number,
    time: number,
  ) {
    this.last = start;
    this.lastTime = time;
  }

  /** Records a pointer sample and returns the distance from the start. */
  move(position: number, time: number): number {
    const elapsed = time - this.lastTime;
    if (elapsed > 0) this.velocity = (position - this.last) / elapsed;
    this.last = position;
    this.lastTime = time;
    return position - this.start;
  }

  /** `time` is the release's timestamp; without it the last sample's speed counts as current. */
  commits(position: number, commitDistance: number, time?: number): boolean {
    const distance = position - this.start;
    if (Math.abs(distance) >= commitDistance) return true;
    if (time !== undefined && time - this.lastTime > FLICK_STALE_MS) return false;
    return (
      Math.abs(distance) >= FLICK_DISTANCE_PX &&
      Math.abs(this.velocity) >= FLICK_VELOCITY_PX_PER_MS &&
      Math.sign(distance) === Math.sign(this.velocity)
    );
  }
}
