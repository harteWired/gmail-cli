// Thin wrapper over the Gmail REST API for the authenticated user (`me`).

import { getAccessToken } from './auth.js';

const BASE = 'https://gmail.googleapis.com/gmail/v1/users/me';

// method: GET/POST; path: e.g. '/messages'; query: object; body: JSON-able.
export async function gmail(method, path, { query, body } = {}) {
  const token = await getAccessToken();
  const url = new URL(BASE + path);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) v.forEach((x) => url.searchParams.append(k, x));
      else url.searchParams.set(k, v);
    }
  }
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    const msg = data?.error?.message || res.statusText;
    throw new Error(`Gmail API ${method} ${path} failed (HTTP ${res.status}): ${msg}`);
  }
  return data;
}
