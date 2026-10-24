// RIFT RAIDERS offline shell. Always fetch the newest game when online.
const CACHE='rift-raiders-shell-v2';
const SHELL=['/index.html','/icon.svg','/icon-192.png','/icon-512.png','/manifest.webmanifest'];
self.addEventListener('install',event=>{
 event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)));
 self.skipWaiting();
});
self.addEventListener('activate',event=>{
 event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('rift-raiders-shell-')&&key!==CACHE).map(key=>caches.delete(key)))));
 self.clients.claim();
});
self.addEventListener('fetch',event=>{
 const req=event.request,url=new URL(req.url);
 if(req.method!=='GET'||url.origin!==self.location.origin)return;
 if(url.pathname.startsWith('/battlepass/')||url.pathname==='/leaderboard'||url.pathname==='/health'||url.pathname==='/ws')return;
 if(req.mode==='navigate'){
  event.respondWith(fetch(new Request(req,{cache:'no-store'})).then(response=>{
   if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put('/index.html',copy)));}
   return response;
  }).catch(()=>caches.match('/index.html')));
  return;
 }
 if(['/icon.svg','/icon-192.png','/icon-512.png','/manifest.webmanifest'].includes(url.pathname)){
  event.respondWith(caches.match(req).then(cached=>cached||fetch(req)));
 }
});
