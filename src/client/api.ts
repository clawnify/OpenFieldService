import {
  announceLiveData,
  announceOfflineData,
  cacheOfflineResponse,
  getOfflineResponse,
  isOfflineDataRequest,
} from "./offline";

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const upperMethod = method.toUpperCase();
  const canUseSavedData = isOfflineDataRequest(upperMethod, path);
  if (upperMethod !== "GET" && !navigator.onLine) {
    throw new Error("You're offline. Changes require a connection and were not saved.");
  }

  const opts: RequestInit = { method, headers: {} };
  if (body) {
    (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  let r: Response;
  let usedSavedData = false;
  try {
    r = await fetch(path, opts);
  } catch {
    if (!canUseSavedData) {
      const message = upperMethod === "GET"
        ? "Some data isn't available offline. Saved schedules and job packets still work."
        : "Unable to reach the server. Changes were not saved.";
      throw new Error(message);
    }
    const cached = await getOfflineResponse(path);
    if (!cached) {
      throw new Error(path.startsWith("/api/schedule")
        ? "This schedule has not been saved for offline use yet. Open it once while connected."
        : "This job is not available offline yet. Open it once while connected.");
    }
    r = cached;
    usedSavedData = true;
  }

  if (r.headers.get("X-OpenFieldService-Offline") === "true") usedSavedData = true;
  if (usedSavedData) announceOfflineData();
  const responseForCache = canUseSavedData && !usedSavedData ? r.clone() : null;
  const text = await r.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Server error: ${r.status} ${r.statusText}`);
  }
  if (!r.ok) throw new Error((data as { error?: string }).error || "Request failed");
  if (responseForCache) {
    announceLiveData();
    void cacheOfflineResponse(path, responseForCache).catch(() => undefined);
  }
  return data as T;
}
