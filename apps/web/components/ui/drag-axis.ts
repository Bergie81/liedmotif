const FLICK_DISTANCE_PX = 24;
const FLICK_VELOCITY_PX_PER_MS = 0.5;

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

  commits(position: number, commitDistance: number): boolean {
    const distance = position - this.start;
    if (Math.abs(distance) >= commitDistance) return true;
    return (
      Math.abs(distance) >= FLICK_DISTANCE_PX &&
      Math.abs(this.velocity) >= FLICK_VELOCITY_PX_PER_MS &&
      Math.sign(distance) === Math.sign(this.velocity)
    );
  }
}
