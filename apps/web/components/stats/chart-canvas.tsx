'use client';

import { useEffect, useRef, useState } from 'react';
import {
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  Chart,
  DoughnutController,
  LinearScale,
  PolarAreaController,
  RadialLinearScale,
  Tooltip,
  type ChartConfiguration,
  type ChartType,
  type TooltipOptions,
} from 'chart.js';

Chart.register(
  ArcElement,
  BarController,
  BarElement,
  CategoryScale,
  DoughnutController,
  LinearScale,
  PolarAreaController,
  RadialLinearScale,
  Tooltip,
);

/** The app's design tokens as a canvas can use them: resolved colors and the mono face. */
export interface ChartTheme {
  paper: string;
  muted: string;
  dim: string;
  line: string;
  lamp: string;
  lampDeep: string;
  second: string;
  track: string;
  /** The card a chart sits on; separates touching marks. */
  surface: string;
  raised: string;
  font: string;
}

function readTheme(canvas: HTMLCanvasElement): ChartTheme {
  const root = getComputedStyle(document.documentElement);
  const token = (name: string) => root.getPropertyValue(name).trim();
  return {
    paper: token('--paper'),
    muted: token('--muted'),
    dim: token('--dim'),
    line: token('--line'),
    lamp: token('--lamp-fill'),
    lampDeep: token('--lamp-deep'),
    second: token('--chart-2'),
    track: token('--meter-track'),
    surface: token('--panel'),
    raised: token('--panel-2'),
    font: getComputedStyle(canvas).fontFamily,
  };
}

/** The app's tooltip, on a canvas. */
export function tooltipStyle(theme: ChartTheme): Partial<TooltipOptions> {
  return {
    backgroundColor: theme.raised,
    borderColor: theme.line,
    borderWidth: 1,
    cornerRadius: 10,
    padding: 8,
    displayColors: false,
    titleColor: theme.muted,
    titleFont: { family: theme.font, size: 11, weight: 'normal' },
    titleMarginBottom: 4,
    bodyColor: theme.paper,
    bodyFont: { family: theme.font, size: 12 },
  };
}

/** The lamp's fade up the plot, deep at the baseline. */
export function lampGradient(chart: Chart, theme: ChartTheme) {
  const area = chart.chartArea;
  if (!area) return theme.lamp;
  const gradient = chart.ctx.createLinearGradient(0, area.bottom, 0, area.top);
  gradient.addColorStop(0, theme.lampDeep);
  gradient.addColorStop(1, theme.lamp);
  return gradient;
}

/**
 * One Chart.js chart drawn in the app's tokens. `config` is rebuilt, and the
 * chart with it, whenever its identity or the theme changes — memoize it.
 */
export function ChartCanvas<T extends ChartType>({
  config,
  label,
  height,
}: {
  config: (theme: ChartTheme) => ChartConfiguration<T>;
  /** What the chart shows, for a reader who cannot see it. */
  label: string;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [light, setLight] = useState(false);

  useEffect(() => {
    const root = document.documentElement;
    const read = () => setLight(root.classList.contains('light'));
    read();
    const observer = new MutationObserver(read);
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const built = config(readTheme(canvas));
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const chart = new Chart<T>(canvas, {
      ...built,
      // Chart.js resolves its option type through the chart type, which is still
      // the parameter `T` here, so the merged object has to be named as one.
      options: {
        responsive: true,
        maintainAspectRatio: false,
        ...built.options,
        ...(reducedMotion ? { animation: false } : null),
      } as ChartConfiguration<T>['options'],
    });
    return () => chart.destroy();
  }, [config, light]);

  return (
    <div style={{ height, position: 'relative' }}>
      <canvas ref={canvasRef} role="img" aria-label={label} className="font-mono" />
    </div>
  );
}
