import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { getErrorMessage } from '@/lib/format-error';
import { trpc } from '@/lib/trpc';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Input } from './ui/input';
import { Label } from './ui/label';

// MQTT + Home Assistant auto-discovery (Batch 7) — configured here instead of env vars, DestCom's
// explicit choice: a single source of truth, applied live via `mqtt.upsert` (no backend restart
// needed, see backend/src/mqtt/manager.ts's reloadMqttClient()).
export function MqttSettingsSection() {
  const queryClient = useQueryClient();
  const { data: settings } = useQuery(trpc.mqtt.get.queryOptions());

  const [url, setUrl] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [discoveryPrefix, setDiscoveryPrefix] = useState('homeassistant');
  const [baseTopic, setBaseTopic] = useState('stroyplant');

  useEffect(() => {
    if (!settings) return;
    setUrl(settings.url ?? '');
    setUsername(settings.username ?? '');
    setDiscoveryPrefix(settings.discoveryPrefix);
    setBaseTopic(settings.baseTopic);
    // Password is deliberately never sent back by the backend — the field starts blank
    // (settings.hasPassword only tells us whether one is set, see the placeholder below).
  }, [settings]);

  const upsertMutation = useMutation(
    trpc.mqtt.upsert.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({ queryKey: trpc.mqtt.get.queryKey() });
        setPassword('');
        toast.success('Configuration MQTT enregistrée');
      },
      onError: (error) => {
        toast.error("Échec de l'enregistrement", { description: getErrorMessage(error) });
      },
    }),
  );

  function handleSave() {
    upsertMutation.mutate({
      url: url.trim() || null,
      username: username.trim() || null,
      // Blank = keep the existing password unchanged (omit the field entirely, see mqtt.upsert).
      password: password === '' ? undefined : password,
      discoveryPrefix: discoveryPrefix.trim() || 'homeassistant',
      baseTopic: baseTopic.trim() || 'stroyplant',
    });
  }

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <CardTitle>MQTT / Home Assistant</CardTitle>
          {settings && (
            <Badge variant={settings.connected ? 'success' : 'secondary'} className="ml-auto">
              {settings.url ? (settings.connected ? 'Connecté' : 'Déconnecté') : 'Désactivé'}
            </Badge>
          )}
        </div>
        <CardDescription>Laisse l'URL du broker vide pour désactiver l'intégration entièrement.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <Label htmlFor="mqtt-url">URL du broker</Label>
          <Input id="mqtt-url" placeholder="mqtt://192.168.1.10:1883" value={url} onChange={(event) => setUrl(event.target.value)} />
        </div>
        <div className="flex gap-4">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="mqtt-username">Utilisateur</Label>
            <Input id="mqtt-username" value={username} onChange={(event) => setUsername(event.target.value)} />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="mqtt-password">Mot de passe</Label>
            <Input
              id="mqtt-password"
              type="password"
              placeholder={settings?.hasPassword ? '••••••••' : ''}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
        </div>
        <div className="flex gap-4">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="mqtt-discovery-prefix">Préfixe de discovery Home Assistant</Label>
            <Input id="mqtt-discovery-prefix" value={discoveryPrefix} onChange={(event) => setDiscoveryPrefix(event.target.value)} />
          </div>
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="mqtt-base-topic">Topic de base</Label>
            <Input id="mqtt-base-topic" value={baseTopic} onChange={(event) => setBaseTopic(event.target.value)} />
          </div>
        </div>
        <Button variant="outline" size="sm" className="self-start" disabled={upsertMutation.isPending} onClick={handleSave}>
          Enregistrer
        </Button>
      </CardContent>
    </Card>
  );
}
