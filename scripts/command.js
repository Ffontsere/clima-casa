/**
 * command.js — Executa comandes AC via repository_dispatch
 * Variables d'entorn:
 *   MELCLOUD_REFRESH_TOKEN
 *   CMD_TYPE    — "control" | "geofence"
 *   CMD_PAYLOAD — JSON del client_payload
 */

import { readFile, writeFile } from 'fs/promises';
import { getAccessToken, getDevices, controlUnit, getRoomTemp } from './melcloud.js';

const TIMEZONE = 'Europe/Madrid';

const type    = process.env.CMD_TYPE    || '';
const payload = JSON.parse(process.env.CMD_PAYLOAD || '{}');

async function main() {
  const token = await getAccessToken(process.env.MELCLOUD_REFRESH_TOKEN);
  console.log(`▶ Comanda: ${type}`, payload);

  if (type === 'control') {
    const { unit_id, ...controls } = payload;
    await controlUnit(token, unit_id, controls);
    console.log('✓ Control aplicat');
  }

  else if (type === 'geofence') {
    const event = payload.event; // "arrive" | "leave"
    if (event === 'leave') {
      // Apagar totes les unitats configurades
      const cfg = JSON.parse(await readFile('data/config.json', 'utf8'));
      for (const unitId of Object.keys(cfg.geofence?.units || {})) {
        await controlUnit(token, unitId, { power: false });
        console.log(`✓ Apagat: ${unitId}`);
      }
    } else if (event === 'arrive') {
      await handleArrive(token);
    }
  }

  // Actualitzar status.json
  const units = await getDevices(token);
  await writeFile('data/status.json', JSON.stringify({ units, updated_at: new Date().toISOString() }, null, 2));
  console.log(`✓ status.json actualitzat`);
}

async function handleArrive(token) {
  const cfg = JSON.parse(await readFile('data/config.json', 'utf8'));
  if (!cfg.geofence?.enabled) { console.log('· Geofence desactivat'); return; }

  const now  = new Date();
  const hm   = new Intl.DateTimeFormat('ca-ES', { timeZone: TIMEZONE, hour:'2-digit', minute:'2-digit', hour12:false }).format(now);
  const [hh, mm] = hm.split(':').map(Number);
  const mins = hh * 60 + mm;

  for (const [unitId, uc] of Object.entries(cfg.geofence.units || {})) {
    if (!uc.enabled) continue;
    if (uc.time_start && uc.time_end) {
      const [hs,ms] = uc.time_start.split(':').map(Number);
      const [he,me] = uc.time_end.split(':').map(Number);
      if (mins < hs*60+ms || mins > he*60+me) { console.log(`· ${unitId}: fora de franja`); continue; }
    }
    const roomTemp = await getRoomTemp(token, unitId);
    let mode = null, temp = uc.target_temp || 22;
    if (roomTemp !== null) {
      if (uc.cool_if_above != null && roomTemp > uc.cool_if_above)      { mode='Cool'; temp=uc.cool_target||24; }
      else if (uc.heat_if_below != null && roomTemp < uc.heat_if_below) { mode='Heat'; temp=uc.heat_target||20; }
      else { console.log(`· ${unitId}: temp ${roomTemp}°C dins rang`); continue; }
    } else if (!uc.cool_if_above && !uc.heat_if_below) { mode='Automatic'; }
    else { console.log(`· ${unitId}: temperatura no llegible`); continue; }

    await controlUnit(token, unitId, { power:true, operationMode:mode, setTemperature:temp, setFanSpeed:uc.fan_speed||'Auto' });
    console.log(`✓ ${unitId}: ${mode} ${temp}°C (sala: ${roomTemp}°C)`);
  }
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });

