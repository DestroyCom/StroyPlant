import { useQueries, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { computeDeviceAlerts } from '@/lib/notifications';
import { trpc } from '@/lib/trpc';

// Mounted once in AppShell (both the mobile header and the desktop sidebar), so it must never
// suspend the whole shell on a route that hasn't already loaded devices.list itself — plain
// useQuery, not useSuspenseQuery, and a quiet no-render while loading.
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const { data: devices } = useQuery(trpc.devices.list.queryOptions());

  const healthQueries = useQueries({
    queries: (devices ?? []).map((device) => ({
      ...trpc.health.deviceHealth.queryOptions({ deviceId: device.id }),
      refetchInterval: 60_000,
    })),
  });

  if (!devices) return null;

  const alerts = devices.flatMap((device, i) => computeDeviceAlerts(device, healthQueries[i]?.data));
  if (alerts.length === 0) return null;

  return (
    <>
      <Button variant="ghost" size="icon-sm" className="relative" onClick={() => setOpen(true)} aria-label="Notifications">
        <Bell size={18} />
        <Badge variant="destructive" className="absolute -top-1.5 -right-1.5 h-4 min-w-4 justify-center px-1 text-[10px]">
          {alerts.length}
        </Badge>
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Notifications</DialogTitle>
            <DialogDescription>
              {alerts.length} alerte{alerts.length > 1 ? 's' : ''} en cours.
            </DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-2">
            {alerts.map((alert) => (
              <li key={`${alert.deviceId}-${alert.message}`}>
                <Link
                  to="/devices/$deviceId"
                  params={{ deviceId: alert.deviceId }}
                  onClick={() => setOpen(false)}
                  className="block rounded-md border border-border-subtle p-3 text-sm hover:bg-muted"
                >
                  <div className="font-medium text-foreground">{alert.deviceName}</div>
                  <div className="text-muted-foreground">{alert.message}</div>
                </Link>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
