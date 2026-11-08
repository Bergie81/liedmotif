'use client';

import { useCallback, useMemo } from 'react';
import type { ChartConfiguration, Plugin, Scale } from 'chart.js';
import { ChartCanvas, lampGradient, tooltipStyle, type ChartTheme } from './chart-canvas';
import type { SplitRow } from './costs-model';
import { figureValueClass, ReadingRow } from './stats-parts';
import { formatListeningTime, rankColor, type DailyPoint, type GenreRow } from './your-stats-model';

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const ROW_HEIGHT = 32;

const axisFont = (theme: ChartTheme) => ({ family: theme.font, size: 10 });

/** Listening time per day, today last. */
export function DailyListeningChart({ points }: { points: DailyPoint[] }) {
  const config = useCallback(
    (theme: ChartTheme): ChartConfiguration<'bar'> => {
      const peak = Math.max(...points.map((point) => point.listenedMs));
      const inHours = peak >= 2 * HOUR_MS;
      const unitMs = inHours ? HOUR_MS : MINUTE_MS;
      return {
        type: 'bar',
        data: {
          labels: points.map((point) => point.label),
          datasets: [
            {
              data: points.map((point) => point.listenedMs / unitMs),
              backgroundColor: ({ chart }) => lampGradient(chart, theme),
              borderRadius: { topLeft: 4, topRight: 4 },
              borderSkipped: 'bottom',
              maxBarThickness: 24,
              categoryPercentage: 0.9,
              barPercentage: 0.8,
            },
          ],
        },
        options: {
          interaction: { mode: 'index', intersect: false },
          plugins: {
            tooltip: {
              ...tooltipStyle(theme),
              callbacks: {
                label: (item) => formatListeningTime(points[item.dataIndex]?.listenedMs ?? 0),
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              border: { color: theme.line },
              ticks: {
                color: theme.dim,
                font: axisFont(theme),
                maxRotation: 0,
                autoSkipPadding: 16,
              },
            },
            y: {
              beginAtZero: true,
              // An empty period still draws a scale instead of a 0–1 sliver.
              suggestedMax: inHours ? 2 : 10,
              border: { display: false },
              grid: { color: theme.line },
              ticks: {
                color: theme.dim,
                font: axisFont(theme),
                maxTicksLimit: 4,
                precision: 0,
                callback: (value) => (value === 0 ? '0' : `${value} ${inHours ? 'h' : 'min'}`),
              },
            },
          },
        },
      };
    },
    [points],
  );

  const busiest = points.reduce<DailyPoint | null>(
    (best, point) => (point.listenedMs > (best?.listenedMs ?? 0) ? point : best),
    null,
  );
  const label = busiest
    ? `Listening time per day over ${points.length} days. Most on ${busiest.label}: ${formatListeningTime(busiest.listenedMs)}.`
    : `Listening time per day over ${points.length} days. Nothing recorded.`;

  return <ChartCanvas config={config} label={label} height={184} />;
}

/**
 * The genre mix as a dial: one wedge per genre, reaching out as far as its
 * share of listening. Exact figures live in the list beside it.
 */
export function GenreDial({ rows }: { rows: GenreRow[] }) {
  const config = useCallback(
    (theme: ChartTheme): ChartConfiguration<'polarArea'> => ({
      type: 'polarArea',
      data: {
        labels: rows.map((row) => row.label),
        datasets: [
          {
            data: rows.map((row) => row.share),
            backgroundColor: rows.map((_, rank) => rankColor(theme.lamp, rank, rows.length)),
            borderColor: theme.surface,
            borderWidth: 2,
          },
        ],
      },
      options: {
        plugins: {
          tooltip: {
            ...tooltipStyle(theme),
            callbacks: {
              title: () => '',
              label: (item) => {
                const row = rows[item.dataIndex];
                return row ? `${row.label}: ${row.time}, ${row.share}%` : '';
              },
            },
          },
        },
        scales: {
          r: {
            beginAtZero: true,
            // The most listened genre reaches the rim.
            max: rows[0]?.share || undefined,
            ticks: { display: false, maxTicksLimit: 4 },
            grid: { color: theme.line },
            angleLines: { display: false },
          },
        },
      },
    }),
    [rows],
  );

  const label = `Share of listening by genre: ${rows.map((row) => `${row.label} ${row.share}%`).join(', ')}.`;
  return <ChartCanvas config={config} label={label} height={200} />;
}

/** The token each mark color is drawn in, on the canvas and in the list beside it. */
const PART_TOKEN = { lamp: '--lamp-fill', second: '--chart-2', track: '--meter-track' } as const;

export interface ChartPart {
  key: string;
  label: string;
  value: number;
  color: keyof typeof PART_TOKEN;
}

const partColor = (color: ChartPart['color']) => `var(${PART_TOKEN[color]})`;

/** Parts of one whole as a ring, the whole in its middle and every part read out beside it. */
export function PartsRing({
  parts,
  total,
  totalLabel,
  extra = [],
}: {
  parts: ChartPart[];
  total: string;
  totalLabel: string;
  /** Readings that are not a part of the whole, listed under the parts. */
  extra?: { label: string; value: string }[];
}) {
  const drawn = useMemo(() => parts.filter((part) => part.value > 0), [parts]);
  const config = useCallback(
    (theme: ChartTheme): ChartConfiguration<'doughnut'> => ({
      type: 'doughnut',
      data: {
        labels: drawn.map((part) => part.label),
        datasets: [
          {
            data: drawn.map((part) => part.value),
            backgroundColor: drawn.map((part) => theme[part.color]),
            borderColor: theme.surface,
            borderWidth: drawn.length > 1 ? 2 : 0,
            borderRadius: 4,
            hoverOffset: 0,
          },
        ],
      },
      options: {
        cutout: '74%',
        plugins: {
          tooltip: {
            ...tooltipStyle(theme),
            callbacks: {
              title: () => '',
              label: (item) => `${item.label}: ${Number(item.raw).toLocaleString('en-US')}`,
            },
          },
        },
      },
    }),
    [drawn],
  );

  const label = `${totalLabel}: ${total}. ${parts.map((part) => `${part.label} ${part.value.toLocaleString('en-US')}`).join(', ')}.`;

  return (
    <div className="flex flex-wrap items-center gap-6">
      <div className="relative h-[136px] w-[136px] shrink-0">
        <ChartCanvas config={config} label={label} height={136} />
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className={figureValueClass}>{total}</span>
          <span className="mt-1 font-mono text-[10.5px] tracking-[0.05em] text-dim">
            {totalLabel}
          </span>
        </div>
      </div>
      <ul className="min-w-[160px] flex-1">
        {parts.map((part) => (
          <ReadingRow
            key={part.key}
            swatch={partColor(part.color)}
            label={part.label}
            value={part.value.toLocaleString('en-US')}
          />
        ))}
        {extra.map((reading) => (
          <ReadingRow key={reading.label} label={reading.label} value={reading.value} />
        ))}
      </ul>
    </div>
  );
}

/** Writes each row's whole past the end of its stacked bar, so a reading needs no hover. */
function barEndLabels(labels: string[], theme: ChartTheme): Plugin<'bar'> {
  return {
    id: 'barEndLabels',
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      const last = chart.getDatasetMeta(chart.data.datasets.length - 1);
      ctx.save();
      ctx.font = `11px ${theme.font}`;
      ctx.fillStyle = theme.muted;
      ctx.textBaseline = 'middle';
      last.data.forEach((bar, index) => {
        ctx.fillText(labels[index] ?? '', bar.x + 8, bar.y);
      });
      ctx.restore();
    },
  };
}

const SPLIT_SERIES = [
  { key: 'music', label: 'Music', color: 'lamp' },
  { key: 'covers', label: 'Covers', color: 'second' },
] as const;

/** Music and Covers stacked per payer, on one shared scale. */
export function CostSplitChart({ rows, subject }: { rows: SplitRow[]; subject: string }) {
  const config = useCallback(
    (theme: ChartTheme): ChartConfiguration<'bar'> => ({
      type: 'bar',
      data: {
        labels: rows.map((row) => row.label),
        datasets: SPLIT_SERIES.map((series) => ({
          label: series.label,
          data: rows.map((row) => row[series.key].value),
          backgroundColor: theme[series.color],
          barThickness: 12,
          // The card's own color around each part keeps the two apart.
          borderColor: theme.surface,
          borderWidth: 1,
          borderRadius: 4,
        })),
      },
      options: {
        indexAxis: 'y',
        layout: { padding: { right: 64 } },
        plugins: {
          tooltip: {
            ...tooltipStyle(theme),
            callbacks: {
              label: (item) => {
                const series = SPLIT_SERIES[item.datasetIndex];
                const row = rows[item.dataIndex];
                return series && row ? `${series.label} ${row[series.key].reading}` : '';
              },
            },
          },
        },
        scales: {
          x: { display: false, stacked: true, beginAtZero: true },
          y: {
            stacked: true,
            grid: { display: false },
            border: { display: false },
            ticks: {
              color: theme.paper,
              font: { family: theme.font, size: 11 },
              // Long names give way to the bars on a phone.
              callback(this: Scale, value: string | number) {
                const text = this.getLabelForValue(Number(value));
                return text.length > 14 ? `${text.slice(0, 13)}…` : text;
              },
            },
          },
        },
      },
      plugins: [
        barEndLabels(
          rows.map((row) => row.reading),
          theme,
        ),
      ],
    }),
    [rows],
  );

  const label = `Music and Covers, ${subject}: ${rows.map((row) => `${row.label} ${row.reading}`).join(', ')}.`;
  return (
    <div>
      <ul className="mb-2 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] tracking-[0.05em] text-muted">
        {SPLIT_SERIES.map((series) => (
          <li key={series.key} className="flex items-center gap-2">
            <span
              aria-hidden
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: partColor(series.color) }}
            />
            {series.label}
          </li>
        ))}
      </ul>
      <ChartCanvas config={config} label={label} height={rows.length * ROW_HEIGHT + 8} />
    </div>
  );
}
