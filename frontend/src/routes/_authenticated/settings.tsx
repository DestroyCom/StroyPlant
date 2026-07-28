import { createFileRoute, Link } from '@tanstack/react-router';
import { Bell, Bot } from 'lucide-react';
import type { ReactNode } from 'react';
import { Badge } from '@/components/ui/badge';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { authClient } from '@/lib/auth-client';

export const Route = createFileRoute('/_authenticated/settings')({
  component: SettingsPage,
});

// Each section below depends on a batch not built yet (docs/STROYPLANT_SPEC.md section 11) —
// shown as a disabled placeholder so the navigation exists, rather than hiding the page entirely.
function ComingSoonSection({ icon, title, description, batch }: { icon: ReactNode; title: string; description: string; batch: string }) {
  return (
    <Card className="opacity-60">
      <CardHeader>
        <div className="flex items-center gap-2.5">
          {icon}
          <CardTitle>{title}</CardTitle>
          <Badge variant="secondary" className="ml-auto">
            Bientôt disponible · {batch}
          </Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
    </Card>
  );
}

function SettingsPage() {
  const { data: session } = authClient.useSession();

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-[30px] leading-tight font-black tracking-tight text-foreground">Réglages</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">Compte et préférences de StroyPlant.</p>
      </div>

      <div className="flex max-w-xl flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Compte</CardTitle>
            <CardDescription>{session?.user.email}</CardDescription>
          </CardHeader>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Arrosage automatique</CardTitle>
            <CardDescription>
              Se configure par appareil, depuis sa fiche détail —{' '}
              <Link to="/" className="text-foreground underline underline-offset-2">
                choisis un Parrot Pot sur le tableau de bord
              </Link>
              .
            </CardDescription>
          </CardHeader>
        </Card>
        <ComingSoonSection
          icon={<Bell size={18} className="text-muted-foreground" />}
          title="Notifications"
          description="Alertes réservoir bas, appareil hors ligne ou score de santé dégradé."
          batch="Lot 7"
        />
        <ComingSoonSection
          icon={<Bot size={18} className="text-muted-foreground" />}
          title="Serveur MCP"
          description="Accès pour les agents IA (Claude, etc.) aux données et actions de StroyPlant."
          batch="Lot 8"
        />
      </div>
    </div>
  );
}
