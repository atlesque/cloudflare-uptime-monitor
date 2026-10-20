// Extra request headers per monitor, for example a secret header that a site's WAF is told to
// let through. Stored in monitors.request_headers as a JSON array of [name, value] pairs.

import { HttpError } from "./http";

export const MAX_REQUEST_HEADERS = 10;
const MAX_VALUE_LENGTH = 1000;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/;
/** Headers the runtime or Cloudflare sets itself; overriding them would break or be ignored. */
const RESERVED = new Set(["host", "content-length", "transfer-encoding", "connection", "upgrade", "te", "trailer"]);

export interface RequestHeader {
  name: string;
  value: string;
}

/** Validates the API's `requestHeaders`; returns the JSON to store, or null for none. */
export function parseRequestHeaders(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v)) throw new HttpError(400, "requestHeaders must be an array of { name, value }");
  if (v.length > MAX_REQUEST_HEADERS) throw new HttpError(400, `At most ${MAX_REQUEST_HEADERS} request headers`);
  const seen = new Set<string>();
  const pairs = v.map((h): [string, string] => {
    if (typeof h !== "object" || h === null || typeof h.name !== "string" || typeof h.value !== "string") {
      throw new HttpError(400, "requestHeaders must be an array of { name, value }");
    }
    const name = h.name.trim();
    const value = h.value.trim();
    const lower = name.toLowerCase();
    if (!TOKEN.test(name)) throw new HttpError(400, `Invalid header name "${name}"`);
    if (RESERVED.has(lower) || lower.startsWith("cf-")) throw new HttpError(400, `The ${name} header can't be set`);
    if (seen.has(lower)) throw new HttpError(400, `The ${name} header is listed twice`);
    if (value.length > MAX_VALUE_LENGTH || /[\0\r\n]/.test(value)) {
      throw new HttpError(400, `The value of ${name} must be one line of at most ${MAX_VALUE_LENGTH} characters`);
    }
    seen.add(lower);
    return [name, value];
  });
  return pairs.length > 0 ? JSON.stringify(pairs) : null;
}

export function parseStoredHeaders(stored: string | null): [string, string][] {
  return stored ? JSON.parse(stored) : [];
}

export function toApiHeaders(stored: string | null): RequestHeader[] {
  return parseStoredHeaders(stored).map(([name, value]) => ({ name, value }));
}
