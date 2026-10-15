// Reads a failed check's response for signs of who produced it: a CDN or WAF block page,
// or an error from the site's own origin. Heuristic; shown next to the raw response.

export interface Diagnosis {
  /** Who most likely produced the response, e.g. "Akamai", or null when nothing points anywhere. */
  source: string | null;
  /** True when the response looks like a bot or WAF block rather than an outage. */
  blocked: boolean;
  /** Akamai's "Reference #" or Cloudflare's Ray ID, for the site owner's support team. */
  reference: string | null;
  /** The observations behind the verdict, in plain words. */
  signals: string[];
}

export function diagnose(status: number | null, headers: [string, string][] | null, body: string | null): Diagnosis {
  const h = new Map<string, string[]>();
  for (const [k, v] of headers ?? []) h.set(k.toLowerCase(), [...(h.get(k.toLowerCase()) ?? []), v]);
  const get = (k: string) => h.get(k)?.join(", ") ?? null;
  const text = decodeEntities(body ?? "");
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(text)?.[1].trim() ?? null;
  const cookies = (h.get("set-cookie") ?? []).map((c) => c.split("=")[0].trim());
  const server = get("server");

  const akamai: string[] = [];
  if (server && /akamai/i.test(server)) akamai.push(`Server header is "${server}"`);
  for (const k of h.keys()) if (k === "akamai-grn" || k.startsWith("x-akamai")) akamai.push(`Akamai header ${k}`);
  if (/errors\.edgesuite\.net/i.test(text)) akamai.push("Body links to errors.edgesuite.net (Akamai error page)");
  const akamaiRef = /Reference\s*#\s*([0-9a-f]+(?:\.[0-9a-f]+){2,})/i.exec(text)?.[1] ?? null;
  const botCookies = cookies.filter((c) => /^(ak_bmsc|bm_sv|bm_sz|bm_mi|_abck|bm_s|bm_so)$/.test(c));
  if (botCookies.length) akamai.push(`Akamai Bot Manager cookies set: ${botCookies.join(", ")}`);

  const cloudflare: string[] = [];
  const ray = get("cf-ray");
  if (server && /cloudflare/i.test(server)) cloudflare.push(`Server header is "${server}"`);
  if (ray) cloudflare.push(`cf-ray ${ray}`);
  const mitigated = get("cf-mitigated");
  if (mitigated) cloudflare.push(`cf-mitigated: ${mitigated}`);

  const envoy: string[] = [];
  if (server && /envoy/i.test(server)) envoy.push(`Server header is "${server}"`);
  for (const k of h.keys()) if (k.startsWith("x-envoy")) envoy.push(`Envoy header ${k}`);
  const envoyBody = /upstream connect error|no healthy upstream|upstream request timeout/i.exec(text)?.[0];
  if (envoyBody) envoy.push(`Body says "${envoyBody}" (Envoy proxy message)`);

  const signals: string[] = [];
  if (title) signals.push(`Page title "${title}"`);
  const retryAfter = get("retry-after");
  if (retryAfter) signals.push(`Retry-After: ${retryAfter}`);

  // An origin error passed through the CDN carries the origin's own markers; prefer those.
  if (envoy.length > 0) {
    return {
      source: "Origin (Envoy proxy)",
      blocked: false,
      reference: akamaiRef,
      signals: [...envoy, ...akamai, ...signals, "The error came from the site's own servers, not from a CDN block"],
    };
  }
  if (akamai.length > 0 || akamaiRef) {
    const denied = status === 403 || /access denied/i.test(title ?? text.slice(0, 2000));
    return {
      source: "Akamai",
      blocked: denied,
      reference: akamaiRef,
      signals: [
        ...akamai,
        ...signals,
        denied
          ? "Looks like an Akamai access-denied (bot or WAF) block"
          : "Akamai answered itself; it may not have reached the origin (edge or origin connection error)",
      ],
    };
  }
  if (cloudflare.length > 0) {
    const challenge = mitigated !== null || /just a moment|attention required/i.test(title ?? "");
    return {
      source: "Cloudflare",
      blocked: challenge,
      reference: ray,
      signals: [...cloudflare, ...signals, ...(challenge ? ["Looks like a Cloudflare challenge or block"] : [])],
    };
  }
  return { source: null, blocked: false, reference: null, signals };
}

// Akamai's error pages write "Reference #" as "Reference&#32;&#35;".
function decodeEntities(s: string): string {
  const char = (code: number, raw: string) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw);
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (raw, hex) => char(parseInt(hex, 16), raw))
    .replace(/&#(\d{1,7});/g, (raw, dec) => char(Number(dec), raw))
    .replace(/&amp;/g, "&");
}
