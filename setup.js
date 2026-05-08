/**
 * setup.js — v4, segueix tota la cadena de redirects fins melcloudhome://
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
function extractCookies(h) {
  const o = {};
  h.forEach((v,k) => {
    if (k.toLowerCase()==='set-cookie') {
      const p=v.split(';')[0].trim(), i=p.indexOf('=');
      if (i>0) o[p.slice(0,i).trim()]=p.slice(i+1).trim();
    }
  });
  return o;
}
const cStr = o => Object.entries(o).map(([k,v])=>`${k}=${v}`).join('; ');
function getCode(url) {
  const m = url.match(/[?&]code=([^&\s"']+)/);
  if (!m) return null;
  try { return decodeURIComponent(m[1]); } catch { return m[1]; }
}

async function exchangeCode(code, verifier) {
  console.log('  → Token exchange, codi:', code.substring(0,25)+'...');
  const r = await fetch(`${AUTH_BASE}/connect/token`, {
    method:'POST',
    headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA_API},
    body: new URLSearchParams({
      grant_type:'authorization_code', code,
      redirect_uri:REDIRECT, code_verifier:verifier, client_id:CLIENT_ID
    }),
  });
  if (!r.ok) { const t=await r.text(); throw new Error(`Token exchange: ${r.status} — ${t}`); }
  const d = await r.json();
  return {refresh_token:d.refresh_token, expiry:Date.now()+d.expires_in*1000};
}

async function login(email, password) {
  const {verifier, challenge} = await makePKCE();
  const sb = new Uint8Array(16); crypto.getRandomValues(sb);
  const state = btoa(String.fromCharCode(...sb)).replace(/=/g,'');
  let cookies = {};

  // 1) PAR
  const parR = await fetch(`${AUTH_BASE}/connect/par`, {
    method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA_API},
    body: new URLSearchParams({response_type:'code',state,code_challenge:challenge,
      code_challenge_method:'S256',client_id:CLIENT_ID,scope:SCOPES,redirect_uri:REDIRECT}),
  });
  if (parR.status!==201) { const t=await parR.text(); throw new Error(`PAR ${parR.status}: ${t}`); }
  const {request_uri} = await parR.json();
  console.log('  ✓ PAR OK');

  // 2) Authorize → Cognito
  const authR = await fetch(
    `${AUTH_BASE}/connect/authorize?client_id=${CLIENT_ID}&request_uri=${encodeURIComponent(request_uri)}`,
    {redirect:'follow', headers:{'User-Agent':UA_API}}
  );
  Object.assign(cookies, extractCookies(authR.headers));
  const html = await authR.text();
  const cognitoUrl = authR.url;

  // Sessió existent? El codi final sempre ve de melcloudhome://
  if (cognitoUrl.startsWith('melcloudhome://')) {
    const fc = getCode(cognitoUrl);
    if (fc) { console.log('  ✓ Codi directe'); return exchangeCode(fc, verifier); }
  }

  const csrf = html.match(/<input[^>]+name="_csrf"[^>]+value="([^"]+)"/)?.[1]
            || html.match(/name="_csrf"\s+value="([^"]+)"/)?.[1];
  if (!csrf) throw new Error('CSRF no trobat');
  console.log('  ✓ CSRF + Cognito OK');

  // 3) Credencials
  const lR = await fetch(cognitoUrl, {
    method:'POST', redirect:'manual',
    headers:{'Content-Type':'application/x-www-form-urlencoded','User-Agent':UA_MOB,
      'Cookie':cStr(cookies),'Origin':new URL(cognitoUrl).origin,'Referer':cognitoUrl},
    body: new URLSearchParams({_csrf:csrf,username:email,password,cognitoAsfData:''}),
  });
  Object.assign(cookies, extractCookies(lR.headers));
  let loc = lR.headers.get('location')||'';
  if (!loc||(loc.startsWith('http')&&new URL(loc).hostname.endsWith(COGNITO_SFX)))
    throw new Error('Credencials invàlides');
  console.log('  ✓ Credencials OK, seguint redirects...');

  // 4) Seguir TOTA la cadena de redirects fins melcloudhome://
  // IMPORTANT: no extreure el codi fins arribar a melcloudhome://
  let next = loc.startsWith('http') ? loc : `${AUTH_BASE}${loc}`;
  for (let i=0; i<10; i++) {
    console.log(`  → Redirect ${i+1}: ${next.substring(0,70)}`);

    // Codi final — ÚNICAMENT des de melcloudhome://
    if (next.startsWith('melcloudhome://')) {
      const code = getCode(next);
      if (!code) throw new Error('melcloudhome:// sense codi');
      console.log('  ✓ Codi final obtingut!');
      return exchangeCode(code, verifier);
    }

    // Seguir redirect HTTP
    const r = await fetch(next, {
      redirect:'manual',
      headers:{'User-Agent':UA_API,'Cookie':cStr(cookies)}
    });
    Object.assign(cookies, extractCookies(r.headers));
    const nl = r.headers.get('location')||'';
    console.log(`     Status: ${r.status} | Dest: ${nl.substring(0,70)}`);

    if (!nl) {
      // Sense redirect — buscar en el body
      const b = await r.text();
      const cbm = b.match(/\/connect\/authorize\/callback\?([^"' ]+)/);
      if (cbm) {
        next = `${AUTH_BASE}/connect/authorize/callback?${cbm[1].replace(/&amp;/g,'&')}`;
      } else {
        // Última opció: codi al body (no a la URL)
        const bc = getCode(b);
        if (bc) { console.log('  ✓ Codi al body'); return exchangeCode(bc, verifier); }
        throw new Error(`Redirect ${i+1} sense Location ni codi`);
      }
    } else {
      next = nl.startsWith('http') ? nl
           : nl.startsWith('melcloudhome') ? nl
           : `${AUTH_BASE}${nl}`;
    }
  }
  throw new Error('Massa redirects sense obtenir codi');
}

(async () => {
  const [,,email,password] = process.argv;
  if (!email||!password) { console.error('Ús: node setup.js EMAIL PASSWORD'); process.exit(1); }
  console.log('\n⏳ Iniciant sessió...\n');
  try {
    const {refresh_token, expiry} = await login(email, password);
    console.log('\n✅ Login correcte!\n');
    console.log('══════════════════════════════════════════');
    console.log('Nom:   MELCLOUD_REFRESH_TOKEN');
    console.log('Valor: ' + refresh_token);
    console.log('══════════════════════════════════════════');
    console.log('Expira: ' + new Date(expiry).toLocaleString());
  } catch(e) {
    console.error('\n❌ Error:', e.message);
    process.exit(1);
  }
})();
