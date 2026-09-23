// F7.7：訊息級加密連結的「公開」面（無 session）：
//   /e/<token>        → 解密頁（HTML，外部腳本，符合 CSP script-src 'self'）
//   /e-decrypt.js     → 解密腳本（WebCrypto；派生邏輯與 src/app/lib/msgcrypto.ts 逐位元一致）
//   /e/<token>/raw    → 密文 bundle（JSON；過期回 410）。站方只存密文/salt/iv，無金鑰/無密碼。

const PAGE_HTML = `<!DOCTYPE html><html lang="zh-Hant"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>加密訊息 · Miseroda</title>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
  background:#0A0E1A;color:#E6EAF2;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang TC","Noto Sans TC",sans-serif}
.card{width:100%;max-width:480px;background:#121829;border:1px solid #232B40;border-radius:18px;
  box-shadow:0 12px 40px rgba(0,0,0,.4);padding:28px}
.logo{font-size:17px;font-weight:600;margin-bottom:14px}
.hint{color:#9AA6BF;font-size:13.5px;margin:0 0 16px}
input{width:100%;padding:11px 14px;border-radius:10px;border:1px solid #2C3550;background:#0D1322;color:#E6EAF2;font-size:15px}
input:focus{outline:none;border-color:#4ADE80}
button{width:100%;margin-top:12px;padding:11px;border-radius:10px;border:none;cursor:pointer;
  background:#4ADE80;color:#06210F;font-weight:600;font-size:15px}
button:disabled{opacity:.6;cursor:default}
.err{margin-top:12px;color:#FF6B8A;font-size:13.5px;display:none}
.subj{font-weight:600;margin-bottom:10px;font-size:16px}
.out{white-space:pre-wrap;word-break:break-word;background:#0D1322;border:1px solid #232B40;border-radius:10px;
  padding:14px;font:14px/1.6 inherit;margin:0;max-height:60vh;overflow:auto}
.foot{margin-top:18px;font-size:12px;text-align:center;color:#6B7689}
</style></head>
<body><div class="card">
<div class="logo">🔒 加密訊息</div>
<div id="form">
  <p class="hint">這是一則加密訊息。請輸入寄件人另外告知你的密碼來解密——內容只在你的瀏覽器解密，伺服器看不到明文。</p>
  <input id="pw" type="password" placeholder="密碼" autocomplete="off" autofocus>
  <button id="btn">解密</button>
  <div id="err" class="err"></div>
</div>
<div id="result" style="display:none">
  <div id="subj" class="subj"></div>
  <pre id="out" class="out"></pre>
</div>
<div class="foot">由 Miseroda Mail 加密 · 端到端</div>
</div><script src="/e-decrypt.js"></script></body></html>`;

const DECRYPT_JS = `(function(){
var ITERS=600000;
function b64d(s){var bin=atob(s),u=new Uint8Array(bin.length);for(var i=0;i<bin.length;i++)u[i]=bin.charCodeAt(i);return u;}
function b64urld(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return b64d(s);}
function show(m){var e=document.getElementById('err');e.textContent=m;e.style.display='block';}
async function deriveKey(pw,salt,frag){
  var pk=await crypto.subtle.importKey('raw',new TextEncoder().encode(pw),'PBKDF2',false,['deriveBits']);
  var bits=await crypto.subtle.deriveBits({name:'PBKDF2',salt:salt,iterations:ITERS,hash:'SHA-256'},pk,256);
  var c=new Uint8Array(32+frag.length);c.set(new Uint8Array(bits),0);c.set(frag,32);
  var kb=await crypto.subtle.digest('SHA-256',c);
  return crypto.subtle.importKey('raw',kb,'AES-GCM',false,['decrypt']);
}
async function run(){
  document.getElementById('err').style.display='none';
  var parts=location.pathname.split('/').filter(Boolean);var token=parts[parts.length-1];
  var frag=new URLSearchParams(location.hash.slice(1)).get('k');
  if(!frag){show('連結不完整：缺少金鑰（請用完整連結開啟）');return;}
  var pw=document.getElementById('pw').value;if(!pw){show('請輸入密碼');return;}
  var btn=document.getElementById('btn');btn.disabled=true;btn.textContent='解密中…';
  var data;
  try{var r=await fetch('/e/'+encodeURIComponent(token)+'/raw');
    if(r.status===410){show('此加密訊息已過期');btn.disabled=false;btn.textContent='解密';return;}
    if(!r.ok){show('找不到此訊息（可能已過期或連結錯誤）');btn.disabled=false;btn.textContent='解密';return;}
    data=await r.json();
  }catch(e){show('讀取失敗，請稍後再試');btn.disabled=false;btn.textContent='解密';return;}
  try{
    var key=await deriveKey(pw,b64d(data.salt),b64urld(frag));
    var pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64d(data.iv)},key,b64d(data.ciphertext));
    document.getElementById('out').textContent=new TextDecoder().decode(pt);
    if(data.subject)document.getElementById('subj').textContent=data.subject;
    document.getElementById('form').style.display='none';
    document.getElementById('result').style.display='block';
  }catch(e){show('密碼錯誤，或連結已損毀');btn.disabled=false;btn.textContent='解密';}
}
document.getElementById('btn').addEventListener('click',run);
document.getElementById('pw').addEventListener('keydown',function(e){if(e.key==='Enter')run();});
})();`;

export function serveEncryptedPage(): Response {
  return new Response(PAGE_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

export function serveDecryptJs(): Response {
  return new Response(DECRYPT_JS, {
    headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  });
}

export async function serveEncryptedData(token: string, env: Env): Promise<Response> {
  // no-store：密文 bundle 帶明文主旨、且 expires_at 一到就該死透——不准任何一層（瀏覽器 HTTP 快取、
  // service worker、中間快取）把它留在磁碟上，否則過期後仍能離線解密。
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
    });
  if (!/^[a-f0-9]{16,128}$/.test(token)) return json({ error: 'not_found' }, 404);
  const row = await env.DB.prepare(`SELECT ciphertext, salt, iv, subject, expires_at FROM encrypted_links WHERE token = ?`)
    .bind(token)
    .first<{ ciphertext: string; salt: string; iv: string; subject: string | null; expires_at: number }>();
  if (!row) return json({ error: 'not_found' }, 404);
  if (row.expires_at <= Date.now()) return json({ error: 'expired' }, 410);
  await env.DB.prepare(`UPDATE encrypted_links SET opened_count = opened_count + 1 WHERE token = ?`).bind(token).run();
  return json({ ciphertext: row.ciphertext, salt: row.salt, iv: row.iv, subject: row.subject });
}
