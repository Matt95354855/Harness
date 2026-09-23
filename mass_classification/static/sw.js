// Cache only the public shell. Sensitive API responses and uploaded material are never cached.
const cacheName='mass-shell-v1';const shell=['/','/static/style.css','/static/app.js'];
self.addEventListener('install',event=>event.waitUntil(caches.open(cacheName).then(cache=>cache.addAll(shell))));
self.addEventListener('fetch',event=>{if(event.request.method==='GET'&&shell.includes(new URL(event.request.url).pathname)){event.respondWith(fetch(event.request).catch(()=>caches.match(event.request)))}});
