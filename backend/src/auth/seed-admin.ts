import { auth } from './auth.js';

// Creates the single admin account (docs/STROYPLANT_SPEC.md section 7.6: single-admin personal
// use, no self sign-up). Uses auth.api.createUser (admin plugin) which, unlike the public
// sign-up endpoint, ignores emailAndPassword.disableSignUp — see auth.ts.
async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set (see .env.example)');
  }

  const result = await auth.api.createUser({
    body: { email, password, name: 'Admin', role: 'admin' },
  });

  console.log(`Admin account created: ${result.user.email} (id=${result.user.id})`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('Failed to create admin account:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
