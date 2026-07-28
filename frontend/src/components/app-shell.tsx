import { useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Home, LogOut, PlusCircle, Settings } from 'lucide-react';
import type { ReactNode } from 'react';
import logo from '@/assets/logo.svg';
import { authClient } from '@/lib/auth-client';
import { useLiveReadings } from '@/lib/use-live-readings';
import { cn } from '@/lib/utils';

export function AppShell({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  useLiveReadings(queryClient);

  async function handleLogout() {
    await authClient.signOut();
    await navigate({ to: '/login' });
  }

  return (
    <div className="flex h-svh overflow-hidden">
      <aside className="flex w-54 shrink-0 flex-col gap-7 overflow-y-auto border-r border-sidebar-border bg-sidebar px-4 py-6 text-sidebar-foreground">
        <div className="flex items-center gap-2.5 px-2">
          <img src={logo} alt="" className="h-6.5 w-6.5" />
          <span className="text-[17px] font-black tracking-tight">StroyPlant</span>
        </div>
        <nav className="flex flex-col gap-1">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent',
              'data-[status=active]:font-bold data-[status=active]:text-sidebar-foreground [&[data-status=active]_svg]:text-sidebar-accent-foreground',
            )}
          >
            <Home size={18} />
            Tableau de bord
          </Link>
          <Link
            to="/devices/add"
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent',
              'data-[status=active]:font-bold data-[status=active]:text-sidebar-foreground [&[data-status=active]_svg]:text-sidebar-accent-foreground',
            )}
          >
            <PlusCircle size={18} />
            Ajouter un appareil
          </Link>
          <Link
            to="/settings"
            className={cn(
              'flex items-center gap-2.5 rounded-md px-3 py-2.5 text-sm font-medium text-sidebar-foreground/70 hover:bg-sidebar-accent',
              'data-[status=active]:font-bold data-[status=active]:text-sidebar-foreground [&[data-status=active]_svg]:text-sidebar-accent-foreground',
            )}
          >
            <Settings size={18} />
            Réglages
          </Link>
        </nav>
        <div className="mt-auto rounded-lg bg-muted p-3 text-xs leading-relaxed text-muted-foreground">
          Clique sur un appareil pour voir son détail et son historique.
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="flex items-center gap-2.5 rounded-md px-3 py-2.5 text-left text-sm text-sidebar-foreground/70 hover:bg-sidebar-accent"
        >
          <LogOut size={16} />
          Se déconnecter
        </button>
      </aside>
      <main className="flex-1 overflow-y-auto bg-background p-10">{children}</main>
    </div>
  );
}
