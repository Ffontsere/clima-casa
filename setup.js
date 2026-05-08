/**
 * setup.js — Configuració inicial MELCloud Home
 * Executa: node setup.js EMAIL PASSWORD
 *
 * Obté el refresh_token i mostra les instruccions per afegir-lo a Netlify.
 */

import { melcloudLogin } from './scripts/melcloud.js';

const [,, email, password] = process.argv;
if (!email || !password) {
  console.error('Ús: node setup.js EMAIL PASSWORD');
  process.exit(1);
}

console.log('\n⏳ Iniciant sessió a MELCloud Home...\n');

try {
  const { access_token, refresh_token, expiry } = await melcloudLogin(email, password);
  const expires = new Date(expiry).toLocaleString('ca-ES');

  console.log('✅ Login correcte!\n');
  console.log('──────────────────────────────────────────────────────────');
  console.log('Afegeix aquest secret a Netlify → Site settings → Env vars:');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`\nMELCLOUD_REFRESH_TOKEN = ${refresh_token}\n`);
  console.log('──────────────────────────────────────────────────────────');
  console.log('I aquest secret a GitHub → Settings → Secrets → Actions:');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`\nMELCLOUD_REFRESH_TOKEN = ${refresh_token}\n`);
  console.log(`Token d'accés expira: ${expires}`);
  console.log('\nEl refresh_token sol durar 30+ dies.');
  console.log('Quan expiri, torna a executar aquest script.\n');

} catch (e) {
  console.error('\n❌ Error:', e.message);
  process.exit(1);
}
