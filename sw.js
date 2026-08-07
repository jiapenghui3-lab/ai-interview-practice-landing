const CACHE_PREFIX = 'ai-interview-shell-';
const CACHE_NAME = `${CACHE_PREFIX}v5`;
const APP_SHELL = [
  './app.html',
  './app.css?v=20260807-5',
  './app.js?v=20260807-3',
  './file-parser.js?v=20260807-1',
  './realtime.js?v=20260807-2',
  './manifest.webmanifest',
  './design-assets/pwa/icon-192.png',
  './design-assets/pwa/icon-512.png',
  './design-assets/pwa/icon-maskable-512.png',
  './design-assets/pwa/apple-touch-icon-180.png',
  './design-assets/app-icons/brand-eye-image2-v1.png',
  './design-assets/app-icons/resume-image2-v1.png',
  './design-assets/app-icons/jd-image2-v1.png',
  './design-assets/app-icons/warning-image2-v1.png',
  './design-assets/app-icons/waveform-image2-v1.png',
  './design-assets/app-environments/preparation-environment-v1.png',
  './design-assets/app-environments/interview-environment-v1.png',
  './design-assets/app-environments/report-environment-v1.png',
  './design-assets/app-ui/interview-camera-placeholder-v1.png',
  './design-assets/characters/yellow-coach-action-v1.png',
  './design-assets/characters/yellow-coach-cutout-v1.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) await cache.put(request, response.clone());
    return response;
  } catch (error) {
    return (await cache.match(request, { ignoreSearch: true }))
      || cache.match('./app.html')
      || Promise.reject(error);
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      const refresh = fetch(request).then(async (response) => {
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, response.clone());
        }
        return response;
      });

      if (cached) {
        event.waitUntil(refresh.catch(() => undefined));
        return cached;
      }
      return refresh;
    })
  );
});
