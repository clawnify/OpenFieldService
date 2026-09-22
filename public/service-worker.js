const SHELL_CACHE = "openfieldservice-shell-v1";
const DATA_CACHE = "openfieldservice-data-v1";
const CACHE_PREFIX = "openfieldservice-";

function isFieldData(url) {
  return url.pathname === "/api/schedule" || /^\/api\/jobs\/[^/]+$/.test(url.pathname);
}

function savedResponse(response) {
  const headers = new Headers(response.headers);
  headers.set("X-OpenFieldService-Offline", "true");
  headers.delete("Content-Encoding");
  headers.delete("Content-Length");
  return response.blob().then((body) => new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.add("/")).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== SHELL_CACHE && name !== DATA_CACHE)
        .map((name) => caches.delete(name))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "CACHE_APP_SHELL" || !Array.isArray(event.data.urls)) return;
  event.waitUntil(caches.open(SHELL_CACHE).then(async (cache) => {
    for (const path of event.data.urls) {
      try { await cache.add(path); } catch { /* One optional asset must not block the shell. */ }
    }
  }));
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isFieldData(url)) {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(DATA_CACHE);
          await cache.put(request, response.clone());
        }
        return response;
      } catch {
        const cached = await caches.match(request, { ignoreVary: true });
        if (cached) return savedResponse(cached);
        const message = url.pathname === "/api/schedule"
          ? "This schedule has not been saved for offline use yet. Open it once while connected."
          : "This job is not available offline yet. Open it once while connected.";
        return Response.json({ error: message }, { status: 503 });
      }
    })());
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(SHELL_CACHE);
          await cache.put("/", response.clone());
        }
        return response;
      } catch {
        return (await caches.match(request, { ignoreVary: true })) || (await caches.match("/", { ignoreVary: true })) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cached = await caches.match(request, { ignoreVary: true });
    if (cached) return cached;
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response.clone());
    }
    return response;
  })());
});
