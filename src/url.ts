// Monitor URL validation and normalization.
//
// Only public HTTP(S) endpoints are allowed. Hostnames are checked as written;
// a Worker cannot resolve DNS itself, so a public name that resolves to a
// private address is not detectable here (Cloudflare's network does not route
// Worker subrequests to private ranges in any case).

export type UrlCheck = { ok: true; url: string } | { ok: false; error: string };

const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa", ".intranet", ".corp"];

export function normalizeMonitorUrl(input: string): UrlCheck {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: "Not a valid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, error: "Only http and https URLs are allowed" };
  }
  if (url.username || url.password) {
    return { ok: false, error: "URLs with credentials are not allowed" };
  }
  const reason = disallowedHostReason(url.hostname);
  if (reason) return { ok: false, error: reason };

  // URL already lowercases the host, strips default ports and normalizes IPv4 forms.
  url.hash = "";
  return { ok: true, url: url.toString() };
}

/** Returns why a hostname is not a public target, or null when it is allowed. */
export function disallowedHostReason(hostname: string): string | null {
  const host = hostname.toLowerCase().replace(/\.$/, "");

  if (host.startsWith("[")) {
    return isPublicIPv6(host.slice(1, -1)) ? null : "Private or reserved IPv6 address";
  }
  const ipv4 = parseIPv4(host);
  if (ipv4) {
    return isPublicIPv4(ipv4) ? null : "Private or reserved IPv4 address";
  }
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) {
    return "Internal hostname";
  }
  if (!host.includes(".")) {
    return "Hostname must be fully qualified";
  }
  return null;
}

function parseIPv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : null;
}

function isPublicIPv4([a, b, c]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false; // this-network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 168) return false; // private
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicIPv6(addr: string): boolean {
  // Only global unicast (2000::/3) is public; this excludes ::, ::1, fc00::/7,
  // fe80::/10, ff00::/8 and IPv4-mapped (::ffff:0:0/96) addresses.
  const first = addr.split(":")[0];
  if (!/^[23][0-9a-f]{0,3}$/.test(first)) return false;
  return !/^2001:0?db8(:|$)/.test(addr); // documentation range
}
