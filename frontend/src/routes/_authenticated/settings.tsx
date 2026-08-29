import { createFileRoute, Link } from '@tanstack/react-router';
import { Bell, Bot, PlusCircle } from 'lucide-react';
import type { ReactNode } from 'react';
import { HealthEngineSettingsSection } from '@/components/health-engine-settings-section';
import { MqttSettingsSection } from '@/components/mqtt-settings-section';
import { PollSettingsSection } from '@/components/poll-settings-section';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { VersionSettingsSection } from '@/components/version-settings-section';
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

      <div className="grid max-w-5xl grid-cols-1 items-start gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Compte</CardTitle>
            <CardDescription>{session?.user.email}</CardDescription>
          </CardHeader>
        </Card>

        <VersionSettingsSection />

        <Card>
          <CardHeader>
            <div className="flex items-center justify-between gap-3">
              <div>
                <CardTitle>Ajouter un appareil</CardTitle>
                <CardDescription>
                  Nommer un capteur détecté pendant que cette page est ouverte, ou l'ajouter directement par adresse.
                </CardDescription>
              </div>
              <Link to="/devices/add">
                <Button variant="outline" size="sm">
                  <PlusCircle size={14} />
                  Ajouter
                </Button>
              </Link>
            </div>
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
        <PollSettingsSection />
        <MqttSettingsSection />
        <HealthEngineSettingsSection />
        <ComingSoonSection
          icon={<Bell size={18} className="text-muted-foreground" />}
          title="Notifications push / e-mail"
          description="Réservoir bas, appareil hors ligne ou score de santé dégradé sont déjà visibles via la cloche en haut du menu — ceci concerne une alerte reçue même sans avoir StroyPlant ouvert."
          batch="Lot futur"
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
