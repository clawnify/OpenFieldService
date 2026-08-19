async function handleResponse<T>(r: Response): Promise<T> {
  const text = await r.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Server error: ${r.status} ${r.statusText}`);
  }
  if (!r.ok) {
    if (r.status === 401) window.dispatchEvent(new Event("auth:unauthorized"));
    throw new Error((data as { error?: string }).error || "Request failed");
  }
  return data as T;
}

export async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = { method, headers: {} };
  if (body) {
    (opts.headers as Record<string, string>)["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(path, opts);
  return handleResponse<T>(r);
}

/** For multipart/form-data uploads (compliance photos) — never JSON-encode a
 *  FormData body, and never set Content-Type manually: the browser generates
 *  the correct multipart boundary itself only when it sets the header. */
export async function apiUpload<T>(method: string, path: string, formData: FormData): Promise<T> {
  const r = await fetch(path, { method, body: formData });
  return handleResponse<T>(r);
}
