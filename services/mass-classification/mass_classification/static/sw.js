// Cache only an anonymous fictional example and its public CSS. Never cache API responses.
const cacheName = 'mass-shell-v3';
const shell = ['/static/offline.html', '/static/style.css', '/static/icon.svg'];
self.addEventListener('install', event => event.waitUntil(caches.open(cacheName).then(cache => cache.addAll(shell))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(names => Promise.all(names.filter(name => name !== cacheName).map(name => caches.delete(name))))));
self.addEventListener('fetch', event => {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).catch(() => caches.match('/static/offline.html')));
    return;
  }
  if (event.request.method === 'GET' && shell.includes(new URL(event.request.url).pathname)) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
  }
});
