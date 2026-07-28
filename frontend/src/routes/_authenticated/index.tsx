import { useSuspenseQuery } from '@tanstack/react-query';
import { createFileRoute } from '@tanstack/react-router';
import { DeviceCard } from '@/components/device-card';
import { isDeviceOnline, isTankLow } from '@/lib/format';
import { devicesQuery } from '@/lib/queries';
import type { Device } from '@/lib/types';

export const Route = createFileRoute('/_authenticated/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(devicesQuery),
  component: DashboardPage,
});

function summarySentence(devices: Device[]): string {
  if (devices.length === 0) return 'Aucun appareil détecté pour le moment.';
  const offline = devices.filter((device) => !isDeviceOnline(device.lastSeenAt)).length;
  const tankLow = devices.filter(isTankLow).length;
  if (offline === 0 && tankLow === 0) return 'Tous tes appareils vont bien aujourd’hui !';
  const issues: string[] = [];
  if (offline > 0) issues.push(`${offline} hors ligne`);
  if (tankLow > 0) issues.push(`${tankLow} réservoir${tankLow > 1 ? 's' : ''} bas`);
  return `${devices.length - offline} en ligne, ${issues.join(', ')}.`;
}

function DashboardPage() {
  const { data: devices } = useSuspenseQuery(devicesQuery);

  return (
    <div>
      <div className="mb-8">
        <div className="mb-1.5 text-sm font-medium text-muted-foreground">Bonjour !</div>
        <h1 className="text-[30px] leading-tight font-black tracking-tight text-foreground">{summarySentence(devices)}</h1>
      </div>

      {devices.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucun appareil détecté pour l'instant. Ils apparaissent automatiquement dès que le scanner BLE les découvre à proximité.
        </p>
      ) : (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-5">
          {devices.map((device) => (
            <DeviceCard key={device.id} device={device} />
          ))}
        </div>
      )}
    </div>
  );
}
