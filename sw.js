/*
 * Offline support.
 *
 * - The page itself comes fresh from the network when online (after 3
 *   seconds on a bad connection, the saved copy is used instead).
 * - Every other file has the build id in its URL, so a saved copy is
 *   always current and loads instantly. New builds use new URLs.
 * - Offline: the saved copies are used.
 *
 * Every file URL carries the build id (?v=...), so one version's files are
 * never mixed with another's. A new build installs a fresh cache and deletes
 * the old ones; the page reloads itself once it takes over.
 */
const BUILD = new URL(self.location.href).searchParams.get('v') || 'dev';
const CACHE = 'pigeon-pal-' + BUILD;

self.addEventListener('install', (e) => {
  // Save the entry page now; everything else is saved as it's used.
  e.waitUntil(caches.open(CACHE)
    .then((c) => Promise.all(['./', 'index.html'].map((u) => c.add(new Request(u, { cache: 'no-cache' })).catch(() => {}))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('pigeon-pal') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  // Files whose URL carries the build id (?v=...) never change, so a saved
  // copy is always right: serve it instantly. Same for engines and icons.
  // (Not while developing, when the id is still the "__BUILD__" placeholder.)
  const v = url.searchParams.get('v');
  const fixed = (v && v !== '__BUILD__') || url.pathname.includes('/vendor/') || url.pathname.includes('/icons/');
  e.respondWith(caches.open(CACHE).then(async (cache) => {
    if (fixed) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
    }
    const net = fetch(e.request, { cache: 'no-cache' }).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    });
    const saved = () => cache.match(e.request).then((hit) => hit || (e.request.mode === 'navigate' ? cache.match('index.html') : null));
    if (e.request.mode !== 'navigate') return net.catch(async (err) => (await saved()) || Promise.reject(err));
    // The page itself: fresh from the network, but don't wait more than a
    // few seconds on a bad connection when there's a saved copy.
    const slow = new Promise((resolve) => setTimeout(resolve, 3000)).then(saved);
    try {
      return await Promise.race([net, slow.then((hit) => hit || net)]);
    } catch (err) {
      const hit = await saved();
      if (hit) return hit;
      throw err;
    }
  }));
});
