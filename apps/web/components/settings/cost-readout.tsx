import { estimatedCostUsd, formatUsd, unitCostsSet, type UnitCosts } from '@liedmotif/shared';

/** Room for a dollar figure beside its count inside a Stepper's value slot. */
export const pricedStepperClass = '[&_output]:max-w-[130px] [&_output]:px-1 [&_output]:py-1';

/** Counts remain the budget authority; dollars estimate those counts at today's prices. */
export function PricedQuantity({
  quantity,
  limit,
  unit,
  costs,
  costFirst = false,
}: {
  quantity: number;
  limit?: number;
  unit: 'Tracks' | 'Covers';
  costs?: UnitCosts | null;
  costFirst?: boolean;
}) {
  function range(format: (count: number) => string): string {
    return limit === undefined ? format(quantity) : `${format(quantity)}/${format(limit)}`;
  }

  const counts = `${range((count) => String(count))} ${unit}`;
  if (!costs || !unitCostsSet(costs)) {
    return <b className="inline-block font-bold text-paper">{counts}</b>;
  }
  const dollars = range((count) =>
    formatUsd(
      estimatedCostUsd(
        unit === 'Tracks' ? { tracks: count, covers: 0 } : { tracks: 0, covers: count },
        costs,
      ),
    ),
  );
  const [primary, secondary] = costFirst ? [dollars, counts] : [counts, dollars];
  return (
    <>
      <b className="inline-block font-bold text-paper">{primary}</b>{' '}
      <span className="inline-block text-dim">({secondary})</span>
    </>
  );
}
