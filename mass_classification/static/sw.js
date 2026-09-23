// Cache only the public shell. Sensitive API responses and uploaded material are never cached.
const cacheName='mass-shell-v2';const shell=['/','/static/style.css','/static/app.js','/static/icon.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(shell))));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(names=>Promise.all(names.filter(name=>name!==cacheName).map(name=>caches.delete(name))))));
self.addEventListener('fetch',event=>{if(event.request.method==='GET'&&shell.includes(new URL(event.request.url).pathname)){event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)))}});
