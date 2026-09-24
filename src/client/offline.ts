export const OFFLINE_DATA_EVENT = "openfieldservice:offline-data";
export const LIVE_DATA_EVENT = "openfieldservice:live-data";
export const OFFLINE_STORAGE_CHANGE_EVENT = "openfieldservice:offline-storage-change";

const DATA_CACHE = "openfieldservice-data-v1";
const DISABLED_CACHE = "openfieldservice-data-disabled-v1";
let savedDataActive = false;

export function isOfflineDataRequest(method: string, path: string): boolean {
  if (method.toUpperCase() !== "GET") return false;
  const pathname = new URL(path, "https://openfieldservice.local").pathname;
  return pathname === "/api/schedule" || /^\/api\/jobs\/[^/]+$/.test(pathname);
}

function requestFor(path: string): Request {
  return new Request(new URL(path, window.location.origin).toString(), { method: "GET" });
}

export async function cacheOfflineResponse(path: string, response: Response): Promise<void> {
  if (!("caches" in window) || !(await isOfflineStorageEnabled())) return;
  const cache = await caches.open(DATA_CACHE);
  if (!(await isOfflineStorageEnabled())) return;
  await cache.put(requestFor(path), response);
  if (!(await isOfflineStorageEnabled())) {
    await caches.delete(DATA_CACHE);
    return;
  }
  window.dispatchEvent(new Event(OFFLINE_STORAGE_CHANGE_EVENT));
}

export async function getOfflineResponse(path: string): Promise<Response | undefined> {
  if (!("caches" in window) || !(await isOfflineStorageEnabled())) return undefined;
  const cache = await caches.open(DATA_CACHE);
  return cache.match(requestFor(path), { ignoreVary: true });
}

export function announceOfflineData(): void {
  savedDataActive = true;
  window.dispatchEvent(new Event(OFFLINE_DATA_EVENT));
}

export function announceLiveData(): void {
  savedDataActive = false;
  window.dispatchEvent(new Event(LIVE_DATA_EVENT));
}

export function isUsingSavedData(): boolean {
  return savedDataActive;
}

export async function hasSavedFieldData(): Promise<boolean> {
  if (!("caches" in window)) return false;
  if (!(await caches.keys()).includes(DATA_CACHE)) return false;
  const cache = await caches.open(DATA_CACHE);
  return (await cache.keys()).length > 0;
}

export async function isOfflineStorageEnabled(): Promise<boolean> {
  if (!("caches" in window)) return false;
  return !(await caches.keys()).includes(DISABLED_CACHE);
}

export async function clearSavedFieldData(): Promise<void> {
  if ("caches" in window) {
    await caches.open(DISABLED_CACHE);
    await caches.delete(DATA_CACHE);
  }
  window.dispatchEvent(new Event(OFFLINE_STORAGE_CHANGE_EVENT));
}

export async function enableOfflineStorage(): Promise<void> {
  if ("caches" in window) await caches.delete(DISABLED_CACHE);
  window.dispatchEvent(new Event(OFFLINE_STORAGE_CHANGE_EVENT));
}

export async function prepareOfflineSupport(): Promise<void> {
  if (!("serviceWorker" in navigator) || !("caches" in window)) return;
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  if (window.location.protocol !== "https:" && !localHost) return;

  try {
    const registration = await navigator.serviceWorker.register("/service-worker.js");
    const ready = await navigator.serviceWorker.ready;
    const worker = ready.active || registration.active;
    if (!worker) return;

    const urls = new Set<string>(["/"]);
    for (const entry of performance.getEntriesByType("resource")) {
      const url = new URL(entry.name);
      if (url.origin === window.location.origin && !url.pathname.startsWith("/api/")) {
        urls.add(url.pathname + url.search);
      }
    }
    worker.postMessage({ type: "CACHE_APP_SHELL", urls: [...urls] });
  } catch {
    // Offline support is progressive enhancement; the online app still works.
  }
}
