/**
 * Netlify Function — /api/*
 * Proxy per MELCloud Home + geofence webhook
 *
 * Env vars Netlify:
 *   MELCLOUD_REFRESH_TOKEN  — token de refresc MELCloud Home
 *   AC_AUTH_TOKEN           — clau per autenticar el dashboard
 *   GITHUB_REPO             — p.ex. "Ffontsere/clima-casa"
 *   GITHUB_PAT              — token GitHub (read repo per llegir config)
 */

import { getAccessToken, getDevices, controlUnit, getRoomTemp } from '../../scripts/melcloud.js';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key',
  'Content-Type': 'application/json',
};

function res(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: CORS });
}

export const config = { path: '/api/:splat*' };

export default async function handler(request) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });

  // Auth
  const key = request.headers.get('x-api-key') || '';
  if (key !== process.env.AC_AUTH_TOKEN) return res({ error: 'No autoritzat' }, 401);

  const url  = new URL(request.url);
  const path = url.pathname.replace(/^\/api/, '');

  try {
    const token = await getAccessToken(process.env.MELCLOUD_REFRESH_TOKEN);

    // ── GET /api/devices ────────────────────────────────────────────────────
    if (path === '/devices' && request.method === 'GET') {
      const units = await getDevices(token);
      return res({ units, ts: Date.now() });
    }

    // ── PUT /api/devices/:id ────────────────────────────────────────────────
    if (path.startsWith('/devices/') && request.method === 'PUT') {
      const unitId = path.split('/')[2];
      const body   = await request.json();
      await controlUnit(token, unitId, body);
      return res({ ok: true });
    }

    // ── POST /api/geofence ──────────────────────────────────────────────────
    if (path === '/geofence' && request.method === 'POST') {
      const { event } = await request.json(); // "arrive" | "leave"
      const result = await handleGeofence(token, event);
      return res(result);
    }

    return res({ error: 'No trobat' }, 404);

  } catch (e) {
    console.error('API error:', e);
    return res({ error: e.message }, 500);
  }
}

// ─── Geofence logic ────────────────────────────────────────────────────────────

async function handleGeofence(token, event) {
  const isArriving = event === 'arrive';
  if (!isArriving) return { ok: true, action: 'left_home' };

  // Llegir config del repo GitHub (fitxer públic)
  const repo    = process.env.GITHUB_REPO || '';
  const cfgUrl  = `https://raw.githubusercontent.com/${repo}/main/data/config.json`;
  const cfgResp = await fetch(cfgUrl);
  if (!cfgResp.ok) return { ok: false, error: 'Config no trobada' };
  const cfg = await cfgResp.json();

  if (!cfg.geofence?.enabled) return { ok: true, skipped: true, reason: 'Geofence desactivat' };

  // Hora local (Catalunya, UTC+1/+2)
  const now  = new Date();
  const tz   = 'Europe/Madrid';
  const hm   = new Intl.DateTimeFormat('ca-ES', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const [hh, mm] = hm.split(':').map(Number);
  const mins = hh * 60 + mm;

  const results = [];

  for (const [unitId, uc] of Object.entries(cfg.geofence.units || {})) {
    if (!uc.enabled) continue;

    // Finestra horària
    if (uc.time_start && uc.time_end) {
      const [hs, ms] = uc.time_start.split(':').map(Number);
      const [he, me] = uc.time_end.split(':').map(Number);
      if (mins < hs * 60 + ms || mins > he * 60 + me) {
        results.push({ unitId, skipped: true, reason: 'Fora de finestra horària' }); continue;
      }
    }

    // Temperatura interior
    const roomTemp = await getRoomTemp(token, unitId);
    let power = false, mode = null, temp = uc.target_temp || 22;

    if (roomTemp !== null) {
      if (uc.cool_if_above != null && roomTemp > uc.cool_if_above) {
        power = true; mode = 'Cool'; temp = uc.cool_target || 24;
      } else if (uc.heat_if_below != null && roomTemp < uc.heat_if_below) {
        power = true; mode = 'Heat'; temp = uc.heat_target || 20;
      } else {
        results.push({ unitId, skipped: true, reason: `Temp ${roomTemp}°C dins rang confort` }); continue;
      }
    } else if (!uc.cool_if_above && !uc.heat_if_below) {
      power = true; mode = 'Automatic';
    } else {
      results.push({ unitId, skipped: true, reason: 'Temperatura no llegible' }); continue;
    }

    if (power) {
      await controlUnit(token, unitId, { power: true, operationMode: mode,
        setTemperature: temp, setFanSpeed: uc.fan_speed || 'Auto' });
      results.push({ unitId, ok: true, mode, temperature: temp, roomTemp });
    }
  }

  return { ok: true, results };
}
