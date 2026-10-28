/* WebSyncTERM service worker: an app-shell cache with a network-first
   strategy for the API and a cache-first strategy for the static assets. */

const CACHE = 'websyncterm-v1';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
	event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
			.then(() => self.clients.claim()),
	);
});

self.addEventListener('fetch', (event) => {
	const url = new URL(event.request.url);
	if (event.request.method !== 'GET') return;
	if (url.pathname.startsWith('/api') || url.pathname.startsWith('/health') || url.pathname.startsWith('/ws')) {
		return;
	}
	event.respondWith(
		caches.match(event.request).then((cached) => {
			const fetched = fetch(event.request)
				.then((response) => {
					if (response.ok && url.origin === self.location.origin) {
						const copy = response.clone();
						void caches.open(CACHE).then((cache) => cache.put(event.request, copy));
					}
					return response;
				})
				.catch(() => cached);
			return cached ?? fetched;
		}),
	);
});
