import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Badge } from './ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';

const REPO = 'DestroyCom/StroyPlant';

interface PublicConfig {
  sentryDsn: string | null;
  gitSha: string | null;
}

function usePublicConfig() {
  return useQuery({
    queryKey: ['public-config'],
    queryFn: async (): Promise<PublicConfig> => {
      const response = await fetch('/api/public-config');
      return (await response.json()) as PublicConfig;
    },
    staleTime: Infinity,
  });
}

// Compares the running backend's baked git SHA (env.ts's gitSha, set at Docker build time from
// github.sha — see Dockerfile/.github/workflows/docker-publish.yml) against GitHub's current
// main branch HEAD, fetched client-side straight from the public, unauthenticated GitHub API (no
// backend involvement, no rate-limit sharing across sessions — this is a single-admin deployment).
// Purely informational: a mismatch only means `docker compose pull && up -d` would pick up newer
// code, nothing is actually broken by running an older build.
export function VersionSettingsSection() {
  const { data: config } = usePublicConfig();
  const [latestSha, setLatestSha] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`https://api.github.com/repos/${REPO}/commits/main`)
      .then((response) => (response.ok ? response.json() : null))
      .then((data: { sha?: string } | null) => {
        if (!cancelled && data?.sha) setLatestSha(data.sha);
      })
      .catch(() => {
        // Best-effort only — offline, rate-limited, or GitHub unreachable must never break the
        // Settings page, this is a nice-to-have notice, not a required check.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runningSha = config?.gitSha ?? null;
  const isOutdated = runningSha != null && latestSha != null && !latestSha.startsWith(runningSha);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2.5">
          <CardTitle>Version</CardTitle>
          {isOutdated && (
            <Badge variant="secondary" className="ml-auto bg-warning-surface text-warning-foreground">
              Mise à jour disponible
            </Badge>
          )}
        </div>
        <CardDescription>
          {runningSha ? (
            <>
              Commit en cours d'exécution :{' '}
              <a
                href={`https://github.com/${REPO}/commit/${runningSha}`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2"
              >
                {runningSha.slice(0, 7)}
              </a>
            </>
          ) : (
            'Build de développement local — aucun commit publié associé.'
          )}
        </CardDescription>
      </CardHeader>
      {isOutdated && (
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Une version plus récente existe sur GitHub. Pense à mettre à jour le conteneur :{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">docker compose pull && docker compose up -d</code>
          </p>
        </CardContent>
      )}
    </Card>
  );
}
