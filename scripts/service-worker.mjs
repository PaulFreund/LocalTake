export function serviceWorkerSource(cache, assets) {
  return `const CACHE=${JSON.stringify(cache)};const ASSETS=${JSON.stringify(assets)};
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS))));
// An update must never replace an application that is recording. No skipWaiting.
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('localtake-')&&key!==CACHE).map(key=>caches.delete(key))))));
const unavailable=()=>new Response('LocalTake ist offline und diese Datei ist nicht im Browsercache vorhanden.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(url.origin!==self.location.origin||request.method!=='GET'||url.pathname.startsWith('/api/')||url.pathname==='/healthz'||url.pathname==='/ws')return;
  if(request.mode!=='navigate'&&!ASSETS.includes(url.pathname))return;
  event.respondWith((async()=>{
    let cache;try{cache=await caches.open(CACHE)}catch{}
    if(request.mode==='navigate'){
      // Always load the current release online. Never overwrite the offline
      // index with HTML whose hashed assets belong to a different release.
      try{const response=await fetch(request);if(response.status<500)return response}catch{}
      try{const index=await cache?.match('/index.html');if(index)return index}catch{}
      return unavailable();
    }
    try{const match=await cache?.match(request);if(match)return match}catch{}
    try{return await fetch(request)}catch{return unavailable()}
  })());
});
`;
}
