// The generating-title "decode" effect (draft design: modern/player.html):
// a left-to-right sweep where a growing prefix locks to the real text while
// the remaining characters churn random glyphs. A sweep runs exactly once per
// text change — steady text stays still, so the effect always signals news.

export const SCRAMBLE_GLYPHS = '/\\|—·░▒#ABCDEFGHKMNPRSTUVXZ';
export const SCRAMBLE_TOTAL_FRAMES = 16;
export const SCRAMBLE_FRAME_MS = 40;

/** One frame of the decode sweep. Spaces never churn, so word shapes hold. */
export function scrambleFrame(target: string, frame: number, random: () => number): string {
  const done = Math.floor((target.length * frame) / SCRAMBLE_TOTAL_FRAMES);
  let out = target.slice(0, done);
  for (let i = done; i < target.length; i++) {
    out += target[i] === ' ' ? ' ' : SCRAMBLE_GLYPHS[Math.floor(random() * SCRAMBLE_GLYPHS.length)];
  }
  return frame >= SCRAMBLE_TOTAL_FRAMES ? target : out;
}

/** The frame after `frame`, or null once the sweep has finished. */
export function nextScrambleFrame(frame: number): number | null {
  return frame < SCRAMBLE_TOTAL_FRAMES ? frame + 1 : null;
}
