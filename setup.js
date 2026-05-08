/**
 * setup.js — Autònom, sense dependències externes
 * Executa: node setup.js EMAIL PASSWORD
 */

const [,, email, password] = process.argv;
if (!email || !password) { console.error('Ús: node setup.js EMAIL PASSWORD'); process.exit(1); }

const AUTH_BASE = 'https://auth.melcloudhome.com';
const CLIENT_ID = 'homemobile';
const REDIRECT  = 'melcloudhome://';
const SCOPES    = 'openid profile email offline_access IdentityServerApi';
const UA_API    = 'MonitorAndControl.App.Mobile/52 CFNetwork/3860.400.51 Darwin/25.3.0';
const UA_MOB    = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/22F76';
const COGNITO_SFX = '.amazoncognito.com';

async function makePKCE() {
  const vb = new Uint8Array(32); crypto.getRandomValues(vb);
  const verifier  = btoa(String.fromCharCode(...vb)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  const digest    = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=/g,'');
  return { verifier, challenge };
}

function extractCookies(headers) {
  const out = {};
  headers.forEach((v, k) => {
    if (k.toLowerCase() === 'set-cookie') {
      const p = v.split(';')[0].trim(); const i = p.indexOf('=');
      if (i > 0) out[p.slice(0,i).trim()] = p.slice(i+1).trim();
    }
  });
  return out;
}
const cStr = obj => Object.entries(obj).map(([k,v])=>`${k}=${v}`).join('; ');

async function login(email, password) {
  const { verifier, challenge } = await makePKCE();
  const sb = new Uint8Array(16); crypto.getRandomValues(sb);
  const state = btoa(String.fromCharCode(...sb)).replace(/=/g,'');
  let cookies = {};

  const parR = await fetch(`${AUTH_BASE}/connect/par`, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA_API},
    body: new URLSearchParams({response_type:'code', state, code_challenge:challenge,
      code_challenge_method:'S256', client_id:CLIENT_ID, scope:SCOPES, redirect_uri:REDIRECT}),
  });
  if (parR.status !== 201) throw new Error(`PAR: ${parR.status}`);
  const { request_uri } = await parR.json();

  const authR = await fetch(`${AUTH_BASE}/connect/authorize?client_id=${CLIENT_ID}&request_uri=${encodeURIComponent(request_uri)}`,
    {redirect:'follow', headers:{'User-Agent':UA_API}});
  Object.assign(cookies, extractCookies(authR.headers));
  const html = await authR.text();
  const cognitoUrl = authR.url;

  const fastCode = cognitoUrl.match(/code=([^&]+)/)?.[1] || html.match(/code=([^&"' ]+)/)?.[1];
  if (fastCode) return exchangeCode(fastCode, verifier);

  const csrf = html.match(/<input[^>]+name="_csrf"[^>]+value="([^"]+)"/)?.[1]
            || html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('CSRF no trobat');

  const loginR = await fetch(cognitoUrl, {
    method:'POST', redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA_MOB,
      'Cookie':cStr(cookies),'Origin':new URL(cognitoUrl).origin,'Referer':cognitoUrl},
    body: new URLSearchParams({_csrf:csrf, username:email, password, cognitoAsfData:''}),
  });
  Object.assign(cookies, extractCookies(loginR.headers));
  let loc = loginR.headers.get('location') || '';
  if (!loc || (loc.startsWith('http') && new URL(loc).hostname.endsWith(COGNITO_SFX)))
    throw new Error('Credencials invàlides');

  let authCode = null, nextUrl = loc.startsWith('http') ? loc : `${AUTH_BASE}${loc}`;
  for (let i = 0; i < 6 && !authCode; i++) {
    if (nextUrl.startsWith('melcloudhome://')) { authCode = nextUrl.match(/code=([^&]+)/)?.[1]; break; }
    const cm = nextUrl.match(/code=([^& ]+)/)?.[1]; if (cm) { authCode = cm; break; }
    const r = await fetch(nextUrl, {redirect:'manual', headers:{'User-Agent':UA_API,'Cookie':cStr(cookies)}});
    Object.assign(cookies, extractCookies(r.headers));
    const nl = r.headers.get('location') || '';
    if (!nl) {
      const body = await r.text();
      const cbm = body.match(/\/connect\/authorize\/callback\?([^"' ]+)/);
      if (cbm) nextUrl = `${AUTH_BASE}/connect/authorize/callback?${cbm[1].replace(/&amp;/g,'&')}`;
      else { authCode = body.match(/code=([^&"' ]+)/)?.[1]; if (!authCode) throw new Error('Codi OAuth no trobat'); }
    } else { nextUrl = nl.startsWith('http') ? nl : nl.startsWith('melcloudhome') ? nl : `${AUTH_BASE}${nl}`; }
  }
  if (!authCode) throw new Error('Auth code no obtingut');
  return exchangeCode(authCode, verifier);
}

async function exchangeCode(code, verifier) {
  const r = await fetch(`${AUTH_BASE}/connect/token`, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA_API},
    body: new URLSearchParams({grant_type:'authorization_code', code,
      redirect_uri:REDIRECT, code_verifier:verifier, client_id:CLIENT_ID}),
  });
  if (!r.ok) throw new Error(`Token exchange: ${r.status}`);
  const d = await r.json();
  return { refresh_token: d.refresh_token, expiry: Date.now() + d.expires_in * 1000 };
}

console.log('\n⏳ Iniciant sessió a MELCloud Home...\n');
try {
  const { refresh_token, expiry } = await login(email, password);
  console.log('✅ Login correcte!\n');
  console.log('══════════════════════════════════════════════════');
  console.log('Afegeix aquest secret (Netlify + GitHub Actions):');
  console.log('══════════════════════════════════════════════════');
  console.log(`MELCLOUD_REFRESH_TOKEN=${refresh_token}`);
  console.log('══════════════════════════════════════════════════');
  console.log(`Expira aprox: ${new Date(expiry).toLocaleString()}\n`);
} catch(e) {
  console.error('\n❌ Error:', e.message);
  process.exit(1);
}
