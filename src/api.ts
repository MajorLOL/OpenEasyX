export function apiHeaders(options?: RequestInit): Headers {
  const headers = new Headers(options?.headers);
  if (options?.body !== undefined && options.body !== null && !headers.has("content-type")) headers.set("content-type", "application/json");
  return headers;
}

export async function api<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...options, headers: apiHeaders(options) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(payload.error ?? `Request failed (${response.status})`, response.status, payload.code, payload.conflict);
  return payload as T;
}
import type { PerformerConflict } from "../packages/profile-identity.js";

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly conflict?: PerformerConflict) { super(message); }
}
