/**
 * MELCloud Home API client
 * Node.js 18+ / Netlify Functions (shared)
 */

const BASE_URL  = 'https://mobile.bff.melcloudhome.com';
const AUTH_BASE = 'https://auth.melcloudhome.com';
const CLIENT_ID = 'homemobile';
const REDIRECT  = 'melcloudhome://';
const SCOPES    = 'openid profile email offline_access IdentityServerApi';
const COGNITO_SFX = '.amazoncognito.com';
const UA_API    = 'MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0';
const UA_MOB    = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76';

// ─── Token ────────────────────────────────────────────────────────────────────

export async function getAccessToken(refreshToken) {
  const r = await fetch(`${AUTH_BASE}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA_API },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
  });
  if (!r.ok) throw new Error(`Token refresh: ${r.status}`);
  const d = await r.json();
  return d.access_token;
}

// ─── PKCE helpers (per setup.js) ──────────────────────────────────────────────

async function makePKCE() {
  const vb = new Uint8Array(32);
  crypto.getRandomValues(vb);
  const verifier  = btoa(String.fromCharCode(...vb)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const digest    = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return { verifier, challenge };
}

function extractCookies(headers) {
  const out = {};
  headers.forEach((v, k) => {
    if (k.toLowerCase() === 'set-cookie') {
      const p = v.split(';')[0].trim();
      const i = p.indexOf('=');
      if (i > 0) out[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
  });
  return out;
}

function cookieStr(obj) { return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('; '); }

// ─── Full OAuth login (used by setup.js) ──────────────────────────────────────

export async function melcloudLogin(email, password) {
  const { verifier, challenge } = await makePKCE();
  const sb = new Uint8Array(16); crypto.getRandomValues(sb);
  const state = btoa(String.fromCharCode(...sb)).replace(/=/g, '');
  let cookies = {};

  // 1) PAR
  const parR = await fetch(`${AUTH_BASE}/connect/par`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA_API },
    body: new URLSearchParams({ response_type: 'code', state, code_challenge: challenge,
      code_challenge_method: 'S256', client_id: CLIENT_ID, scope: SCOPES, redirect_uri: REDIRECT }),
  });
  if (parR.status !== 201) throw new Error(`PAR: ${parR.status}`);
  const { request_uri } = await parR.json();

  // 2) Authorize → Cognito login page
  const authR = await fetch(`${AUTH_BASE}/connect/authorize?client_id=${CLIENT_ID}&request_uri=${encodeURIComponent(request_uri)}`,
    { redirect: 'follow', headers: { 'User-Agent': UA_API } });
  Object.assign(cookies, extractCookies(authR.headers));
  const html = await authR.text();
  const cognitoUrl = authR.url;

  // Sessió existent?
  const fastCode = cognitoUrl.match(/code=([^&]+)/)?.[1] || html.match(/code=([^&"' ]+)/)?.[1];
  if (fastCode) return exchangeCode(fastCode, verifier);

  const csrf = html.match(/<input[^>]+name="_csrf"[^>]+value="([^"]+)"/)?.[1]
            || html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('CSRF no trobat');

  // 3) Credencials
  const loginR = await fetch(cognitoUrl, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA_MOB,
      'Cookie': cookieStr(cookies), 'Origin': new URL(cognitoUrl).origin, 'Referer': cognitoUrl },
    body: new URLSearchParams({ _csrf: csrf, username: email, password, cognitoAsfData: '' }),
  });
  Object.assign(cookies, extractCookies(loginR.headers));
  let loc = loginR.headers.get('location') || '';
  if (!loc || (loc.startsWith('http') && new URL(loc).hostname.endsWith(COGNITO_SFX)))
    throw new Error('Credencials invàlides');

  // 4) Seguir redirects
  let authCode = null;
  let nextUrl  = loc.startsWith('http') ? loc : `${AUTH_BASE}${loc}`;
  for (let i = 0; i < 6 && !authCode; i++) {
    if (nextUrl.startsWith('melcloudhome://')) { authCode = nextUrl.match(/code=([^&]+)/)?.[1]; break; }
    const cm = nextUrl.match(/code=([^& ]+)/)?.[1];
    if (cm) { authCode = cm; break; }
    const r = await fetch(nextUrl, { redirect: 'manual', headers: { 'User-Agent': UA_API, 'Cookie': cookieStr(cookies) } });
    Object.assign(cookies, extractCookies(r.headers));
    const nl = r.headers.get('location') || '';
    if (!nl) {
      const body = await r.text();
      const cbm = body.match(/\/connect\/authorize\/callback\?([^"' ]+)/);
      if (cbm) nextUrl = `${AUTH_BASE}/connect/authorize/callback?${cbm[1].replace(/&amp;/g, '&')}`;
      else { authCode = body.match(/code=([^&"' ]+)/)?.[1]; if (!authCode) throw new Error('Codi OAuth no trobat'); }
    } else {
      nextUrl = nl.startsWith('http') ? nl : nl.startsWith('melcloudhome') ? nl : `${AUTH_BASE}${nl}`;
    }
  }
  if (!authCode) throw new Error('Auth code no obtingut');
  return exchangeCode(authCode, verifier);
}

async function exchangeCode(code, verifier) {
  const r = await fetch(`${AUTH_BASE}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA_API },
    body: new URLSearchParams({ grant_type: 'authorization_code', code,
      redirect_uri: REDIRECT, code_verifier: verifier, client_id: CLIENT_ID }),
  });
  if (!r.ok) throw new Error(`Token exchange: ${r.status}`);
  const d = await r.json();
  return { access_token: d.access_token, refresh_token: d.refresh_token,
           expiry: Date.now() + d.expires_in * 1000 };
}

// ─── Dispositius ──────────────────────────────────────────────────────────────

export async function getDevices(accessToken) {
  const r = await fetch(`${BASE_URL}/context`, {
    headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA_API },
  });
  if (!r.ok) throw new Error(`getDevices: ${r.status}`);
  const ctx = await r.json();
  const units = [];
  for (const bld of ctx.buildings || []) {
    for (const u of bld.airToAirUnits || []) {
      units.push({ id: u.id, name: u.name, power: u.power,
        operationMode: u.operationMode, setTemperature: u.setTemperature,
        roomTemperature: u.roomTemperature, setFanSpeed: u.setFanSpeed,
        isInError: u.isInError, inStandbyMode: u.inStandbyMode, building: bld.name });
    }
  }
  return units;
}

export async function controlUnit(accessToken, unitId, updates) {
  const payload = { power: null, operationMode: null, setFanSpeed: null,
    vaneHorizontalDirection: null, vaneVerticalDirection: null,
    setTemperature: null, temperatureIncrementOverride: null, inStandbyMode: null, ...updates };
  const r = await fetch(`${BASE_URL}/monitor/ataunit/${unitId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json', 'User-Agent': UA_API },
    body: JSON.stringify(payload),
  });
  if (!r.ok) throw new Error(`controlUnit: ${r.status}`);
  return r.json();
}

export async function getRoomTemp(accessToken, unitId) {
  try {
    const r = await fetch(`${BASE_URL}/telemetry/telemetry/actual/${unitId}`,
      { headers: { Authorization: `Bearer ${accessToken}`, 'User-Agent': UA_API } });
    if (!r.ok) return null;
    const d = await r.json();
    const m = (d?.measureData || []).find(x => x.key === 'RoomTemperature' || x.key === 'roomTemperature');
    return m?.values?.[0]?.value ?? null;
  } catch { return null; }
}
