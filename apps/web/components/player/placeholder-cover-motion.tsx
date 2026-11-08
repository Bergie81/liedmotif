'use client';

import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import './placeholder-cover-motion.css';

type Bar = 't' | 'y' | 'r';
const BARS: readonly Bar[] = ['t', 'y', 'r'];

/** Seeded PRNG: the scene is generated once per module, identically on the
 *  server and the client, so hydration never sees a different streak field. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rgb = readonly [number, number, number];
const TEAL: Rgb = [19, 224, 181];
const AMBER: Rgb = [252, 187, 41];
const RED: Rgb = [255, 82, 45];

function mix(a: Rgb, b: Rgb, k: number): Rgb {
  const at = (i: 0 | 1 | 2) => Math.round(a[i] + (b[i] - a[i]) * k);
  return [at(0), at(1), at(2)];
}

/** Streak color by horizontal position (percent): teal left, red right. */
function colorAt(x: number): Rgb {
  if (x < 42) return TEAL;
  if (x < 50) return mix(TEAL, AMBER, (x - 42) / 8);
  if (x < 58) return mix(AMBER, RED, (x - 50) / 8);
  return RED;
}

/** Streaks are brightest right beside the bars and fade toward the edges. */
function falloff(x: number): number {
  const d = x < 50 ? Math.max(0, 34 - x) / 34 : Math.max(0, x - 66) / 34;
  return Math.max(0.06, Math.pow(1 - d, 1.2));
}

/** Two clusters flanking the bars, plus a few rising above them. */
function sampleX(rand: () => number): number {
  const u = rand();
  if (u < 0.45) return 5 + Math.pow(rand(), 0.85) * 31;
  if (u < 0.9) return 95 - Math.pow(rand(), 0.85) * 30;
  return 36 + rand() * 28;
}

function regionOf(x: number): Bar {
  return x < 42 ? 't' : x < 58 ? 'y' : 'r';
}

/** Depth layers, far to near: thinner, dimmer, finer-dotted in the back. */
const DEPTHS = [
  { count: 84, width: 0.1, alpha: 0.4, period: 0.42, speed: 1.8, falls: false },
  { count: 48, width: 0.14, alpha: 0.65, period: 0.55, speed: 1.4, falls: true },
  { count: 20, width: 0.2, alpha: 0.95, period: 0.7, speed: 1.0, falls: true },
] as const;

interface Streak {
  region: Bar;
  className: string;
  style: CSSProperties;
}

function buildStreaks(): Streak[] {
  const rand = mulberry32(7);
  const streaks: Streak[] = [];
  for (const depth of DEPTHS) {
    for (let i = 0; i < depth.count; i++) {
      const x = sampleX(rand);
      const [r, g, b] = colorAt(x);
      const alpha = depth.alpha * falloff(x) * (0.35 + rand() * 0.65);
      const flickers = rand() < 0.35;
      const style: Record<string, string> = {
        left: `${x.toFixed(2)}%`,
        top: `${(6 + rand() * 24).toFixed(1)}%`,
        bottom: `${(12 + rand() * 14).toFixed(1)}%`,
        '--w': `${depth.width}cqmin`,
        '--c': `rgb(${r} ${g} ${b} / ${alpha.toFixed(3)})`,
        '--on': (0.5 + rand() * 0.4).toFixed(2),
        '--p': `${depth.period}cqmin`,
        '--speed': `${(depth.speed * (0.85 + rand() * 0.3)).toFixed(2)}s`,
        '--offset': `${(rand() * depth.period).toFixed(2)}cqmin`,
      };
      if (flickers) {
        style['--fdur'] = `${(1.6 + rand() * 3).toFixed(2)}s`;
        style['--fdel'] = `-${(rand() * 4).toFixed(2)}s`;
      }
      streaks.push({
        region: regionOf(x),
        className: `pcm-streak${depth.falls ? ' pcm-fall' : ''}${flickers ? ' pcm-flicker' : ''}`,
        style: style as CSSProperties,
      });
    }
  }
  return streaks;
}

function buildSparks(): { bar: Bar; style: CSSProperties }[] {
  const rand = mulberry32(11);
  return BARS.flatMap((bar) =>
    Array.from({ length: 6 }, () => ({
      bar,
      style: {
        '--sx': (0.1 + rand() * 0.8).toFixed(2),
        '--sdur': `${(2.4 + rand() * 2.6).toFixed(2)}s`,
        '--sdel': `-${(rand() * 5).toFixed(2)}s`,
        '--drift': `${((rand() - 0.5) * 3).toFixed(2)}cqmin`,
        '--rise': `${(9 + rand() * 12).toFixed(1)}cqmin`,
      } as CSSProperties,
    })),
  );
}

const STREAKS = buildStreaks();
const SPARKS = buildSparks();

/** The built-in placeholder cover as a living scene, shown on the hero cover
 *  while a Session still wears the placeholder (its generated cover is on the
 *  way, or none is configured). Purely decorative; it fills its positioned,
 *  square parent. Reduced-motion users get the still composition. */
export function PlaceholderCoverMotion() {
  const sceneRef = useRef<HTMLDivElement>(null);
  // Every animation's phase is pinned to document time rather than to mount,
  // so the scene remounting (the connecting frame handing over to the live
  // player) continues mid-beat instead of snapping back to the rest pose.
  // Set before paint so the first frame is already in phase.
  useLayoutEffect(() => {
    sceneRef.current?.style.setProperty('--pcm-phase', `-${Math.round(performance.now())}ms`);
  }, []);
  return (
    <div ref={sceneRef} className="pcm-scene" aria-hidden data-testid="placeholder-cover-motion">
      {BARS.map((bar) => (
        <div key={`haze-${bar}`} className={`pcm-haze pcm-${bar}`} />
      ))}
      <div className="pcm-floor-glow" />
      <div className="pcm-hairlines" />
      {BARS.map((bar) => (
        <div key={`region-${bar}`} className={`pcm-region pcm-${bar}`}>
          {STREAKS.filter((s) => s.region === bar).map((s, i) => (
            <i key={i} className={s.className} style={s.style} />
          ))}
        </div>
      ))}
      <div className="pcm-sweep" />
      {BARS.map((bar) => (
        <div key={`halo-${bar}`} className={`pcm-halo pcm-${bar}`} />
      ))}
      {BARS.map((bar) => (
        <div key={`bar-${bar}`} className={`pcm-bar pcm-${bar}`} />
      ))}
      {SPARKS.map((spark, i) => (
        <i key={`spark-${i}`} className={`pcm-spark pcm-${spark.bar}`} style={spark.style} />
      ))}
      <div className="pcm-grain" />
      <div className="pcm-vignette" />
    </div>
  );
}
