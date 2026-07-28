import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Leaf } from 'lucide-react';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authClient } from '@/lib/auth-client';

interface LoginSearch {
  redirect?: string;
}

export const Route = createFileRoute('/login')({
  validateSearch: (search: Record<string, unknown>): LoginSearch =>
    typeof search.redirect === 'string' ? { redirect: search.redirect } : {},
  component: LoginPage,
});

function LoginPage() {
  const navigate = useNavigate();
  const search = Route.useSearch();
  const emailId = useId();
  const passwordId = useId();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    const { error } = await authClient.signIn.email({ email, password });
    setPending(false);

    if (error) {
      toast.error('Connexion impossible', { description: error.message ?? 'Vérifie ton email et ton mot de passe.' });
      return;
    }

    await navigate({ to: search.redirect ?? '/' });
  }

  return (
    <div className="flex min-h-svh w-full">
      <div className="relative hidden flex-1 flex-col items-center justify-center overflow-hidden bg-[linear-gradient(160deg,var(--color-teal-700),var(--color-teal-500))] p-16 text-center text-white md:flex">
        <div className="mb-7 flex h-30 w-30 items-center justify-center rounded-full bg-white/12">
          <Leaf size={60} strokeWidth={1.6} />
        </div>
        <h2 className="max-w-sm text-4xl font-black tracking-tight">Content de te revoir</h2>
        <p className="mt-3 max-w-sm text-lg text-paper-400">Tes plantes t'attendent. Connecte-toi pour prendre de leurs nouvelles.</p>
      </div>
      <div className="flex flex-1 items-center justify-center p-10">
        <form className="flex w-full max-w-sm flex-col gap-5" onSubmit={handleSubmit}>
          <div>
            <h1 className="text-[26px] font-black tracking-tight text-foreground">Se connecter</h1>
            <p className="mt-1.5 text-sm text-muted-foreground">C'est juste toi et tes plantes ici.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={emailId}>Adresse email</Label>
            <Input
              id={emailId}
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="toi@exemple.com"
              className="h-10"
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor={passwordId}>Mot de passe</Label>
            <Input
              id={passwordId}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="••••••••"
              className="h-10"
            />
          </div>
          <Button type="submit" size="lg" disabled={pending} className="mt-1 h-11">
            {pending ? 'Connexion…' : 'Se connecter'}
          </Button>
        </form>
      </div>
    </div>
  );
}
