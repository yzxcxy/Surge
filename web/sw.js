const CACHE = 'surge-v14';
const ASSETS = ['/', '/index.html', '/style.css', '/app.mjs', '/core.mjs', '/db.mjs', '/icon.svg', '/manifest.webmanifest', '/rich-editor.mjs', '/updates.mjs'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => { const url = new URL(event.request.url); if (event.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; event.respondWith(fetch(event.request).then(async response => { if(response.ok) (await caches.open(CACHE)).put(event.request,response.clone()); return response; }).catch(()=>caches.match(event.request))); });
