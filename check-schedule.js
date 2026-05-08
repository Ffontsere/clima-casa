/**
 * check-schedule.js — Cronotermòstat
 * Executat per GitHub Actions cada 10 minuts
 *
 * Env vars necessàries:
 *   MELCLOUD_REFRESH_TOKEN
 *   GITHUB_TOKEN (auto, per push)
 */

import { readFile, writeFile } from 'fs/promises';
import { getAccessToken, getDevices, controlUnit } from './melcloud.js';

const TZ = 'Europe/Madrid';

async function main() {
  // 1) Hora local
  const now    = new Date();
  const dayNum = parseInt(new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'narrow' })
    .format(now) === 'S' ? (now.getDay() === 0 ? 0 : 6) : now.getDay());
  const hm = new Intl.DateTimeFormat('ca-ES', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const [hh, mm] = hm.split(':').map(Number);

  console.log(`⏰ ${now.toISOString()} → hora local ${hm} (dia ${dayNum})`);

  // 2) Llegir configuració
  const cfg = JSON.parse(await readFile('data/config.json', 'utf8'));
  const schedules = cfg.schedules || {};

  // 3) Obtenir token MELCloud
  const token = await getAccessToken(process.env.MELCLOUD_REFRESH_TOKEN);

  // 4) Comprovar cada programació
  let acted = false;
  for (const [unitId, sched] of Object.entries(schedules)) {
    for (const entry of sched.entries || []) {
      if (!entry.enabled) continue;
      if (!entry.days.includes(dayNum)) continue;
      const [eh, em] = entry.time.split(':').map(Number);
      if (eh !== hh || em !== mm) continue;

      console.log(`▶ Unitat ${unitId}: acció "${entry.action}" a ${entry.time}`);
      if (entry.action === 'off') {
        await controlUnit(token, unitId, { power: false });
      } else {
        await controlUnit(token, unitId, {
          power: true,
          operationMode: entry.mode || 'Automatic',
          setTemperature: entry.temperature || 22,
          setFanSpeed: entry.fanSpeed || 'Auto',
        });
      }
      acted = true;
    }
  }

  // 5) Actualitzar status.json (cada execució)
  try {
    const units = await getDevices(token);
    const status = { units, updated_at: now.toISOString() };
    await writeFile('data/status.json', JSON.stringify(status, null, 2));
    console.log(`✓ status.json actualitzat (${units.length} unitats)`);
  } catch (e) {
    console.error('No s\'ha pogut actualitzar status.json:', e.message);
  }

  console.log(acted ? '✓ Acció executada' : '· Sense acció aquest minut');
}

main().catch(e => { console.error(e); process.exit(1); });
