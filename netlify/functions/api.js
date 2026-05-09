/**
 * Netlify Function — api.js (sintaxi clàssica, autònoma)
 * Rutes via event.path:
 *   GET  /api/devices        → llista unitats
 *   PUT  /api/devices/:id    → controla unitat
 *   POST /api/geofence       → geofence webhook
 */

const BASE_URL  = 'https://mobile.bff.melcloudhome.com';
const AUTH_BASE = 'https://auth.melcloudhome.com';
const CLIENT_ID = 'homemobile';
const UA        = 'MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type,X-API-Key',
  'Content-Type': 'application/json',
};

function res(data, code = 200) {
  return { statusCode: code, headers: CORS, body: JSON.stringify(data) };
}

// ── Token ──────────────────────────────────────────────────────────────────
async function getToken(refreshToken) {
  const r = await fetch(`${AUTH_BASE}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID }),
  });
  if (!r.ok) throw new Error(`Token refresh: ${r.status}`);
  return (await r.json()).access_token;
}

// ── Dispositius ────────────────────────────────────────────────────────────
async function getDevices(token) {
  const r = await fetch(`${BASE_URL}/context`, {
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA },
  });
  if (!r.ok) throw new Error(`getDevices: ${r.status}`);
  const ctx = await r.json();
  const units = [];
  for (const b of ctx.buildings || [])
    for (const u of b.airToAirUnits || [])
      units.push({ id: u.id, name: u.name, power: u.power, operationMode: u.operationMode,
        setTemperature: u.setTemperature, roomTemperature: u.roomTemperature,
        setFanSpeed: u.setFanSpeed, isInError: u.isInError, building: b.name });
  return units;
}

async function controlUnit(token, unitId, updates) {
  const payload = { power:null, operationMode:null, setFanSpeed:null,
    vaneHorizontalDirection:null, vaneVerticalDirection:null,
    setTemperature:null, temperatureIncrementOverride:null, inStandbyMode:null, ...updates };
  const r = await fetch(`${BASE_URL}/monitor/ataunit/${unitId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`control: ${r.status}`);
  return r.json();
}

async function getRoomTemp(token, unitId) {
  try {
    const r = await fetch(`${BASE_URL}/telemetry/telemetry/actual/${unitId}`,
      { headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA } });
    if (!r.ok) return null;
    const d = await r.json();
    const m = (d?.measureData || []).find(x => x.key === 'RoomTemperature' || x.key === 'roomTemperature');
    return m?.values?.[0]?.value ?? null;
  } catch { return null; }
}

// ── Geofence ───────────────────────────────────────────────────────────────
async function handleGeofence(token, event) {
  if (event !== 'arrive') return { ok: true, action: 'left_home' };
  const repo = process.env.GITHUB_REPO || '';
  const cfgR = await fetch(`https://raw.githubusercontent.com/${repo}/main/data/config.json`);
  if (!cfgR.ok) return { ok: false, error: 'Config no trobada' };
  const cfg = await cfgR.json();
  if (!cfg.geofence?.enabled) return { ok: true, skipped: true };

  const now = new Date();
  const hm  = new Intl.DateTimeFormat('ca-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
  const [hh, mm] = hm.split(':').map(Number);
  const mins = hh * 60 + mm;
  const results = [];

  for (const [unitId, uc] of Object.entries(cfg.geofence.units || {})) {
    if (!uc.enabled) continue;
    if (uc.time_start && uc.time_end) {
      const [hs,ms] = uc.time_start.split(':').map(Number);
      const [he,me] = uc.time_end.split(':').map(Number);
      if (mins < hs*60+ms || mins > he*60+me) { results.push({ unitId, skipped: 'horari' }); continue; }
    }
    const roomTemp = await getRoomTemp(token, unitId);
    let mode = null, temp = uc.target_temp || 22;
    if (roomTemp !== null) {
      if (uc.cool_if_above != null && roomTemp > uc.cool_if_above) { mode = 'Cool'; temp = uc.cool_target || 24; }
      else if (uc.heat_if_below != null && roomTemp < uc.heat_if_below) { mode = 'Heat'; temp = uc.heat_target || 20; }
      else { results.push({ unitId, skipped: 'rang confort', roomTemp }); continue; }
    } else if (!uc.cool_if_above && !uc.heat_if_below) { mode = 'Automatic'; }
    else { results.push({ unitId, skipped: 'temperatura no llegible' }); continue; }

    await controlUnit(token, unitId, { power: true, operationMode: mode, setTemperature: temp, setFanSpeed: uc.fan_speed || 'Auto' });
    results.push({ unitId, ok: true, mode, temperature: temp, roomTemp });
  }
  return { ok: true, results };
}

// ── Handler principal ──────────────────────────────────────────────────────
exports.handler = async function(event) {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };

  const apiKey = event.headers['x-api-key'] || event.headers['X-API-Key'] || '';
  if (apiKey !== process.env.AC_AUTH_TOKEN) return res({ error: 'No autoritzat' }, 401);

  // Normalitzar path: /api/devices, /api/devices/ID, /api/geofence
  const path = (event.path || '').replace(/^\/.netlify\/functions\/api/, '').replace(/^\/api/, '') || '/';

  try {
    const token = await getToken(process.env.MELCLOUD_REFRESH_TOKEN);

    if (path === '/devices' && event.httpMethod === 'GET') {
      const units = await getDevices(token);
      return res({ units, ts: Date.now() });
    }

    if (path.startsWith('/devices/') && event.httpMethod === 'PUT') {
      const unitId = path.split('/')[2];
      const body   = JSON.parse(event.body || '{}');
      await controlUnit(token, unitId, body);
      return res({ ok: true });
    }

    if (path === '/geofence' && event.httpMethod === 'POST') {
      const { event: geoEvent } = JSON.parse(event.body || '{}');
      return res(await handleGeofence(token, geoEvent));
    }

    return res({ error: 'No trobat', path }, 404);
  } catch (e) {
    console.error('API error:', e.message);
    return res({ error: e.message }, 500);
  }
};

