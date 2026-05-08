/**
 * setup.js — v5: captura cookies de tots els redirects intermedis
 */

const AUTH_BASE   = 'https://auth.melcloudhome.com';
const CLIENT_ID   = 'homemobile';
const REDIRECT    = 'melcloudhome://';
const SCOPES      = 'openid profile email offline_access IdentityServerApi';
const UA_API      = 'MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0';
const UA_MOB      = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76';
const COGNITO_SFX = '.amazoncognito.com';

async function makePKCE() {
  const vb = new Uint8Array(32); crypto.getRandomValues(vb);
  const v = btoa(String.fromCharCode(...vb)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v));
  const c = btoa(String.fromCharCode(...new Uint8Array(d))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return { verifier: v, challenge: c };
}

// Captura TOTES les cookies d'una resposta (inclou múltiples Set-Cookie)
function extractCookies(h) {
  const o = {};
  h.forEach((v, k) => {
    if (k.toLowerCase() === 'set-cookie') {
      const p = v.split(';')[0].trim(), i = p.indexOf('=');
      if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim();
    }
  });
  return o;
}
const cStr = o => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('; ');

function getCode(s) {
  const m = s.match(/[?&]code=([^&\s"']+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

async function exchangeCode(code, verifier) {
  console.log('  → Token exchange...');
  const r = await fetch(`${AUTH_BASE}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA_API },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code,
      redirect_uri: REDIRECT, code_verifier: verifier, client_id: CLIENT_ID
    }),
  });
  if (!r.ok) { const t = await r.text(); throw new Error(`Token exchange: ${r.status} — ${t}`); }
  const d = await r.json();
  return { refresh_token: d.refresh_token, expiry: Date.now() + d.expires_in * 1000 };
}

async function login(email, password) {
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
  if (parR.status !== 201) { const t = await parR.text(); throw new Error(`PAR ${parR.status}: ${t}`); }
  const { request_uri } = await parR.json();
  console.log('  ✓ PAR OK');

  // 2) Authorize — seguir MANUALMENT tots els redirects per capturar cookies IdentityServer
  let nextUrl = `${AUTH_BASE}/connect/authorize?client_id=${CLIENT_ID}&request_uri=${encodeURIComponent(request_uri)}`;
  let cognitoUrl = null, csrf = null;

  for (let i = 0; i < 8; i++) {
    const r = await fetch(nextUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': UA_API, 'Cookie': cStr(cookies) }
    });
    Object.assign(cookies, extractCookies(r.headers));
    const loc = r.headers.get('location') || '';
    const status = r.status;
    console.log(`  Authorize redirect ${i}: ${status} → ${loc.substring(0, 70)}`);

    if (status === 200) {
      // Pàgina de login Cognito
      cognitoUrl = nextUrl;
      const html = await r.text();
      csrf = html.match(/<input[^>]+name="_csrf"[^>]+value="([^"]+)"/)?.[1]
          || html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
      break;
    }

    if (!loc) throw new Error(`Authorize: status ${status} sense redirect`);

    // Detectar pàgina de login Cognito per la URL (cas redirect directe)
    if (loc.includes('.amazoncognito.com') && loc.includes('/login')) {
      // Seguir aquest redirect per obtenir la pàgina (i les cookies Cognito)
      const cr = await fetch(loc, { redirect: 'manual', headers: { 'User-Agent': UA_MOB } });
      Object.assign(cookies, extractCookies(cr.headers));
      cognitoUrl = cr.headers.get('location') || loc;
      if (cr.status === 200) {
        cognitoUrl = loc;
        const html = await cr.text();
        csrf = html.match(/<input[^>]+name="_csrf"[^>]+value="([^"]+)"/)?.[1]
            || html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
        break;
      }
    }

    nextUrl = loc.startsWith('http') ? loc : `${AUTH_BASE}${loc}`;
  }

  if (!cognitoUrl || !csrf) throw new Error('No s\'ha trobat la pàgina de login Cognito');
  console.log('  ✓ Cognito URL i CSRF OK');

  // 3) Credencials
  const lR = await fetch(cognitoUrl, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA_MOB,
      'Cookie': cStr(cookies), 'Origin': new URL(cognitoUrl).origin, 'Referer': cognitoUrl },
    body: new URLSearchParams({ _csrf: csrf, username: email, password, cognitoAsfData: '' }),
  });
  Object.assign(cookies, extractCookies(lR.headers));
  let loc = lR.headers.get('location') || '';
  if (!loc || (loc.startsWith('http') && new URL(loc).hostname.endsWith(COGNITO_SFX)))
    throw new Error('Credencials invàlides');
  console.log('  ✓ Credencials OK');

  // 4) Seguir cadena de redirects — ÚNICAMENT extreure codi de melcloudhome://
  let next = loc.startsWith('http') ? loc : `${AUTH_BASE}${loc}`;
  for (let i = 0; i < 10; i++) {
    console.log(`  → Redirect ${i + 1}: ${next.substring(0, 80)}`);
    if (next.startsWith('melcloudhome://')) {
      const code = getCode(next);
      if (!code) throw new Error('melcloudhome:// sense codi');
      console.log('  ✓ Codi final obtingut');
      return exchangeCode(code, verifier);
    }
    const r = await fetch(next, {
      redirect: 'manual',
      headers: { 'User-Agent': UA_API, 'Cookie': cStr(cookies) }
    });
    Object.assign(cookies, extractCookies(r.headers));
    const nl = r.headers.get('location') || '';
    console.log(`     Status: ${r.status} | Dest: ${nl.substring(0, 70)}`);
    if (!nl) {
      const b = await r.text();
      const cbm = b.match(/\/connect\/authorize\/callback\?([^"' ]+)/);
      if (cbm) next = `${AUTH_BASE}/connect/authorize/callback?${cbm[1].replace(/&amp;/g, '&')}`;
      else throw new Error(`Redirect ${i + 1}: status ${r.status} sense Location`);
    } else {
      next = nl.startsWith('http') ? nl : nl.startsWith('melcloudhome') ? nl : `${AUTH_BASE}${nl}`;
    }
  }
  throw new Error('Massa redirects sense obtenir codi');
}

(async () => {
  const email    = process.env.MC_EMAIL || process.argv[2];
  const password = process.env.MC_PASS  || process.argv[3];
  if (!email || !password) { console.error('Cal MC_EMAIL i MC_PASS'); process.exit(1); }
  console.log('\n⏳ Iniciant sessió...\n');
  try {
    const { refresh_token, expiry } = await login(email, password);
    console.log('\n✅ Login correcte!\n');
    console.log('══════════════════════════════════════════');
    console.log('Nom:   MELCLOUD_REFRESH_TOKEN');
    console.log('Valor: ' + refresh_token);
    console.log('══════════════════════════════════════════');
    console.log('Expira: ' + new Date(expiry).toLocaleString());
  } catch (e) {
    console.error('\n❌ Error:', e.message);
    process.exit(1);
  }
})();
