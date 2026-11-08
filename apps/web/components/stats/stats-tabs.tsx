'use client';

import type { CostComparisonData, ListeningStatsData } from '@liedmotif/shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { fetchCostComparison, fetchListeningStats } from '@/lib/api-client';
import { Costs } from './costs';
import { costPeriodLabel } from './costs-model';
import { PeriodLabel, PeriodPicker } from './stats-parts';
import { useRangedRead, type RangedRead } from './use-ranged-read';
import { YourStats } from './your-stats';
import { periodLabel } from './your-stats-model';

/** `costs` is present for the Admin alone; without it there is no tab bar at all. */
export function StatsTabs({
  listening,
  costs,
}: {
  listening: ListeningStatsData;
  costs: CostComparisonData | null;
}) {
  const listeningRead = useRangedRead(
    listening,
    fetchListeningStats,
    'Your Stats could not be loaded.',
  );
  if (costs) return <AdminStats listeningRead={listeningRead} costs={costs} />;
  return (
    <div className="mt-6">
      <PeriodPicker
        range={listeningRead.range}
        onChange={(next) => void listeningRead.load(next)}
      />
      <PeriodLabel>{periodLabel(listeningRead.data)}</PeriodLabel>
      <YourStats read={listeningRead} />
    </div>
  );
}

/** One picker above both tabs means one period: it drives both reads, so a tab
 *  switch never changes what the picker shows. */
function AdminStats({
  listeningRead,
  costs,
}: {
  listeningRead: RangedRead<ListeningStatsData>;
  costs: CostComparisonData;
}) {
  const costsRead = useRangedRead(costs, fetchCostComparison, 'The costs could not be loaded.');

  return (
    <Tabs defaultValue="listening" className="mt-6">
      <div className="flex flex-col gap-6 desk:flex-row desk:gap-10">
        <TabsList aria-label="Your Stats" className="desk:flex-1">
          <TabsTrigger value="listening">Listening</TabsTrigger>
          <TabsTrigger value="costs">Costs</TabsTrigger>
        </TabsList>
        <PeriodPicker
          className="desk:w-[300px] desk:flex-none"
          range={listeningRead.range}
          onChange={(next) => {
            void listeningRead.load(next);
            void costsRead.load(next);
          }}
        />
      </div>
      <TabsContent value="listening" className="mt-0">
        <PeriodLabel>{periodLabel(listeningRead.data)}</PeriodLabel>
        <YourStats read={listeningRead} />
      </TabsContent>
      <TabsContent value="costs" className="mt-0">
        <PeriodLabel>{costPeriodLabel(costsRead.data)}</PeriodLabel>
        <Costs read={costsRead} />
      </TabsContent>
    </Tabs>
  );
}
