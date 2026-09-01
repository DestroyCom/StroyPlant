import { useQuery, useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { AlertTriangle, ChevronDown, Droplets } from 'lucide-react';
import { useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { dayBucketLabel } from '@/lib/format';
import { getErrorMessage } from '@/lib/format-error';
import { trpc } from '@/lib/trpc';
import type { HistoryEntry } from '@/lib/types';
import { cn } from '@/lib/utils';

type Period = 'all' | '7' | '30';
const PERIOD_DAYS: Record<Period, number | undefined> = { all: undefined, '7': 7, '30': 30 };

export const Route = createFileRoute('/_authenticated/history')({
  loader: ({ context }) => context.queryClient.ensureQueryData(trpc.devices.list.queryOptions()),
  component: HistoryPage,
});

interface DayGroup {
  label: string;
  entries: HistoryEntry[];
}

// Entries arrive pre-sorted desc from history.list, so consecutive same-day entries always end up
// adjacent — no need to re-sort here, just fold them into buckets in a single pass.
function groupByDay(entries: HistoryEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const entry of entries) {
    const label = dayBucketLabel(entry.timestamp);
    const last = groups.at(-1);
    if (last && last.label === label) last.entries.push(entry);
    else groups.push({ label, entries: [entry] });
  }
  return groups;
}

function entryLabel(entry: HistoryEntry): string {
  if (entry.type === 'WATERING') {
    if (entry.success) return `${entry.deviceName} a été arrosé${entry.triggerLabel === 'CRON' ? ' automatiquement' : ' à la main'}`;
    return `Échec de l'arrosage de ${entry.deviceName}`;
  }
  if (entry.triggerLabel === 'CONFIG_PUSH') return `Échec de configuration de l'arrosage autonome sur ${entry.deviceName}`;
  const sourceLabel = entry.triggerLabel === 'POLL' ? 'automatique' : 'manuelle';
  return `Échec de synchro (${sourceLabel}) sur ${entry.deviceName}`;
}

function HistoryRow({ entry }: { entry: HistoryEntry }) {
  const failed = !entry.success;
  return (
    <div className="flex items-center gap-3 rounded-lg border border-border bg-card p-4">
      <div
        className={cn(
          'flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
          failed ? 'bg-destructive/10 text-destructive' : 'bg-teal-100 text-teal-700',
        )}
      >
        {entry.type === 'WATERING' ? <Droplets size={14} /> : <AlertTriangle size={14} />}
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-foreground">{entryLabel(entry)}</div>
        {failed && entry.errorDetail && <div className="mt-0.5 text-xs wrap-break-word text-muted-foreground">{entry.errorDetail}</div>}
      </div>
      <div className="shrink-0 text-xs text-muted-foreground">
        {new Date(entry.timestamp).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}
      </div>
    </div>
  );
}

function HistoryPage() {
  const { data: devices } = useSuspenseQuery(trpc.devices.list.queryOptions());
  const [deviceId, setDeviceId] = useState('');
  const [period, setPeriod] = useState<Period>('all');
  const {
    data: entries,
    isPending,
    isError,
    error,
  } = useQuery(trpc.history.list.queryOptions({ deviceId: deviceId || undefined, days: PERIOD_DAYS[period] }));
  const groups = entries ? groupByDay(entries) : [];

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-[22px] leading-tight font-black tracking-tight text-foreground md:text-[30px]">Journal d'arrosage</h1>
      </div>

      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative w-full sm:w-56">
          <select
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
            aria-label="Filtrer par plante"
            className="h-9 w-full appearance-none rounded-lg border border-input bg-transparent px-3 pr-8 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <option value="">Toutes les plantes</option>
            {devices.map((device) => (
              <option key={device.id} value={device.id}>
                {device.name ?? device.id}
              </option>
            ))}
          </select>
          <ChevronDown size={14} className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground" />
        </div>

        <Tabs value={period} onValueChange={(value) => setPeriod(value as Period)}>
          <TabsList>
            <TabsTrigger value="all">Tout</TabsTrigger>
            <TabsTrigger value="7">7 jours</TabsTrigger>
            <TabsTrigger value="30">30 jours</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {isPending ? (
        <p className="text-sm text-muted-foreground">Chargement…</p>
      ) : isError ? (
        <p className="text-sm text-destructive">Impossible de charger l'historique : {getErrorMessage(error)}</p>
      ) : groups.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucun événement pour cette période.</p>
      ) : (
        <div className="flex flex-col gap-6">
          {groups.map((group) => (
            <div key={group.label}>
              <div className="mb-2 text-xs font-medium tracking-wide text-muted-foreground uppercase">{group.label}</div>
              <div className="flex flex-col gap-2">
                {group.entries.map((entry) => (
                  <HistoryRow key={entry.id} entry={entry} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
