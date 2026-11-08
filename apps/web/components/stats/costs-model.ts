import {
  estimatedCostUsd,
  formatUsd,
  unitCostsSet,
  type CostComparisonData,
  type CostCounts,
  type UnitCosts,
} from '@liedmotif/shared';
import { counted, rangeOpening } from './your-stats-model';

export interface CostGroup {
  key: string;
  label: string;
  counts: CostCounts;
  /** Music and Covers together at today's prices; null while no price is set. */
  estimate: string | null;
}

export interface CostGroups {
  /** Whether any dollar figure may show — the rule every Estimated cost readout follows. */
  priced: boolean;
  total: CostGroup;
  own: CostGroup;
  members: CostGroup;
  /** Members by estimated cost, dearest first; Former members last, only once they have spend. */
  perMember: CostGroup[];
}

export function costGroups(data: CostComparisonData): CostGroups {
  const priced = unitCostsSet(data.unitCosts);
  const usd = (counts: CostCounts) => estimatedCostUsd(counts, data.unitCosts);
  const group = (key: string, label: string, counts: CostCounts): CostGroup => ({
    key,
    label,
    counts: { tracks: counts.tracks, covers: counts.covers },
    estimate: priced ? formatUsd(usd(counts)) : null,
  });

  const perMember = [...data.perMember]
    .sort((a, b) => usd(b) - usd(a) || b.tracks + b.covers - (a.tracks + a.covers))
    .map((member) => group(`member:${member.userId}`, member.name, member));
  const { formerMembers } = data;
  if (formerMembers.tracks > 0 || formerMembers.covers > 0) {
    perMember.push(group('former-members', 'Former members', formerMembers));
  }

  return {
    priced,
    total: group('total', 'Total', data.total),
    own: group('own', 'You', data.own),
    members: group('members', 'Members combined', data.members),
    perMember,
  };
}

/** One part of a stacked bar: what is drawn, and how a tooltip reads it. */
interface SplitPart {
  value: number;
  reading: string;
}

/** One payer's stacked bar. */
export interface SplitRow {
  key: string;
  label: string;
  music: SplitPart;
  covers: SplitPart;
  /** The row's whole, as it reads past the end of its bar. */
  reading: string;
}

/**
 * Each group as a stacked bar: dollars at today's prices, or plain counts while
 * no price is set — one unit per chart, so the bars share a scale.
 */
export function splitRows(groups: CostGroup[], costs: UnitCosts): SplitRow[] {
  const priced = unitCostsSet(costs);
  return groups.map(({ key, label, counts, estimate }) => {
    const tracks = counted(counts.tracks, 'track', 'tracks');
    const covers = counted(counts.covers, 'cover', 'covers');
    if (!priced) {
      return {
        key,
        label,
        music: { value: counts.tracks, reading: tracks },
        covers: { value: counts.covers, reading: covers },
        reading: (counts.tracks + counts.covers).toLocaleString('en-US'),
      };
    }
    const musicUsd = estimatedCostUsd({ tracks: counts.tracks, covers: 0 }, costs);
    const coversUsd = estimatedCostUsd({ tracks: 0, covers: counts.covers }, costs);
    return {
      key,
      label,
      music: { value: musicUsd, reading: `${formatUsd(musicUsd)}, ${tracks}` },
      covers: { value: coversUsd, reading: `${formatUsd(coversUsd)}, ${covers}` },
      reading: estimate ?? '',
    };
  });
}

/** Cost periods are cut on the budget calendar, which the label says apart from the reporting one. */
export function costPeriodLabel(data: CostComparisonData): string {
  return `${rangeOpening(data)} · Budget timezone ${data.timezone}`;
}
