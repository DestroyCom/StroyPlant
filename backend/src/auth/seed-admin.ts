import { auth } from './auth.js';

// Crée l'unique compte admin (STROYPLANT_SPEC.md section 7.6 : usage perso mono-admin, pas
// d'auto-inscription). Utilise auth.api.createUser (plugin admin) qui, contrairement à l'endpoint
// public de sign-up, ignore emailAndPassword.disableSignUp — voir auth.ts.
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL et ADMIN_PASSWORD doivent être définis (voir .env.example)');
  }

  const result = await auth.api.createUser({
    body: { email, password, name: 'Admin', role: 'admin' },
  });

  console.log(`Compte admin créé : ${result.user.email} (id=${result.user.id})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Échec de la création du compte admin:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
