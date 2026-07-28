import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Droplets, Thermometer } from 'lucide-react';
import { formatDeviceKind, formatRelativeTime, statusBandClasses, statusHeadline } from '@/lib/format';
import { trpc } from '@/lib/trpc';
import type { Device } from '@/lib/types';
import { DeviceKindIcon } from './device-kind-icon';

export function DeviceCard({ device }: { device: Device }) {
  const reading = device.lastReading;
  const { data: health } = useQuery(trpc.health.deviceHealth.queryOptions({ deviceId: device.id }, { refetchInterval: 60_000 }));
  const { band, icon } = statusBandClasses(device, health);
  const primaryValue = device.kind === 'PARROT_POT' ? reading?.soilMoisturePercent : reading?.humidityPercent;

  return (
    <Link to="/devices/$deviceId" params={{ deviceId: device.id }} className="block">
      <div className="flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-sm transition-[box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:shadow-md">
        <div className={`flex items-center justify-center ${band} py-6`}>
          <div className="flex h-19 w-19 items-center justify-center rounded-full bg-card shadow-sm">
            <DeviceKindIcon kind={device.kind} size={30} className={icon} />
          </div>
        </div>
        <div className="flex flex-1 flex-col gap-2 p-4">
          <div>
            <div className="font-bold text-foreground">{device.name ?? device.id}</div>
            <div className="text-xs text-muted-foreground">
              {formatDeviceKind(device.kind)} · {formatRelativeTime(device.lastSeenAt)}
            </div>
          </div>
          <div className="min-h-9.5 text-sm font-medium text-foreground">{statusHeadline(device, health)}</div>
          <div className="mt-0.5 flex gap-3 border-t border-border-subtle pt-1 text-[11px] text-muted-foreground">
            {primaryValue != null && (
              <span className="inline-flex items-center gap-1">
                <Droplets size={12} />
                {Math.round(primaryValue)}%
              </span>
            )}
            {reading?.temperatureC != null && (
              <span className="inline-flex items-center gap-1">
                <Thermometer size={12} />
                {Math.round(reading.temperatureC)}°
              </span>
            )}
          </div>
        </div>
      </div>
    </Link>
  );
}
