const CACHE_PREFIX = "pilot-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${"__PILOT_CACHE_VERSION__"}`;
const PRECACHE_URLS = ["__PILOT_PRECACHE_MANIFEST__"];
const PRECACHE_PATHS = new Set(
  PRECACHE_URLS.map((url) => new URL(url, self.location.origin).pathname),
);

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/")));
    return;
  }

  if (PRECACHE_PATHS.has(url.pathname)) {
    event.respondWith(
      caches
        .open(CACHE_NAME)
        .then((cache) => cache.match(request, { ignoreSearch: true }))
        .then((cached) => cached ?? fetch(request)),
    );
  }
});
