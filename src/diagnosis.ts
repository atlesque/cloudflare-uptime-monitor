// Reads a failed check's response for signs of who produced it: a CDN or WAF block page,
// or an error from the site's own origin. Heuristic; shown next to the raw response.

export interface Diagnosis {
  /** Who most likely produced the response, e.g. "Akamai", or null when nothing points anywhere. */
  source: string | null;
  /** True when the response looks like a bot or WAF block rather than an outage. */
  blocked: boolean;
  /** The most useful of `references` (Akamai's first), or null when there is none. */
  reference: string | null;
  /** IDs to quote to the site owner's support team: Akamai's reference and Cloudflare's Ray ID. */
  references: { label: string; value: string; meaning?: string }[];
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
  const akamaiRef = findAkamaiReference(text);
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

  const references: Diagnosis["references"] = [];
  if (akamaiRef) {
    const meaning = AKAMAI_ERROR_TYPES[akamaiRef.split(".")[0]];
    references.push({ label: "Akamai reference", value: akamaiRef, ...(meaning ? { meaning } : {}) });
  }
  if (ray) references.push({ label: "Cloudflare Ray ID", value: ray });
  const result = (source: string | null, blocked: boolean, signals: string[]): Diagnosis => ({
    source,
    blocked,
    reference: references[0]?.value ?? null,
    references,
    signals,
  });

  const signals: string[] = [];
  if (title) signals.push(`Page title "${title}"`);
  const retryAfter = get("retry-after");
  if (retryAfter) signals.push(`Retry-After: ${retryAfter}`);

  // An origin error passed through the CDN carries the origin's own markers; prefer those.
  if (envoy.length > 0) {
    return result("Origin (Envoy proxy)", false, [
      ...envoy,
      ...akamai,
      ...signals,
      "The error came from the site's own servers, not from a CDN block",
    ]);
  }
  // An Akamai reference in the body names Akamai even when Cloudflare relayed the page.
  if (akamai.length > 0 || akamaiRef) {
    const denied = status === 403 || /access denied/i.test(title ?? text.slice(0, 2000));
    if (akamaiRef && akamai.length === 0) akamai.push(`Body quotes an Akamai reference (#${akamaiRef})`);
    return result("Akamai", denied, [
      ...akamai,
      ...cloudflare,
      ...signals,
      ...(cloudflare.length ? ["The response also passed through Cloudflare"] : []),
      denied
        ? "Looks like an Akamai access-denied (bot or WAF) block"
        : "Akamai answered itself; it may not have reached the origin (edge or origin connection error)",
    ]);
  }
  if (cloudflare.length > 0) {
    const challenge = mitigated !== null || /just a moment|attention required/i.test(title ?? "");
    return result("Cloudflare", challenge, [
      ...cloudflare,
      ...signals,
      ...(challenge ? ["Looks like a Cloudflare challenge or block"] : []),
    ]);
  }
  return result(null, false, signals);
}

// The first part of an Akamai reference is the kind of error the edge server hit.
const AKAMAI_ERROR_TYPES: Record<string, string> = {
  "0": "WAF or Bot Manager block: the request was taken for an attack or a bot",
  "1": "Read timeout: the origin did not answer in time (120 s by default)",
  "3": "Read error: Akamai connected to the origin, but no response came back",
  "4": "Write error: the connection closed before Akamai could send the whole request",
  "6": "Connection failed: the origin, or a firewall in front of it, refused the connection",
  "7": "Invalid request: the request was malformed or not RFC compliant",
  "11": "DNS failure: Akamai could not resolve the origin's hostname",
  "13": "Forwarding denied: part of SureRoute testing, usually harmless",
  "15": "Zero-size object: the origin sent an empty response",
  "18": "Access denied: a WAF rule (including DoS protection and geoblocking), or a certificate name mismatch",
  "24": "Referrer denied: the Referer header was not allowed",
  "27": "Client abort: the client closed the connection to Akamai",
  "30": "Origin TLS handshake failed: the origin's certificate is invalid, expired, missing its chain, or for another name",
};

/**
 * Finds Akamai's error reference in a page, e.g. "Reference #18.5b6a1002.1792080000.3c4d5e6f".
 * Sites often wrap it in their own words and markup ("referentie: <b>#0.103ad417.1792462692.15193b11</b>"),
 * so this also accepts the bare "#" form: four dot-separated parts, the third a Unix time.
 */
export function findAkamaiReference(html: string): string | null {
  const text = html.replace(/<[^>]*>/g, " ");
  const labelled = /Reference\s*#\s*([0-9a-f]+(?:\.[0-9a-f]+){2,})/i.exec(text)?.[1];
  if (labelled) return labelled;
  return /#\s*([0-9a-f]{1,4}\.[0-9a-f]{4,10}\.\d{10}\.[0-9a-f]{4,10})(?![\w.])/i.exec(text)?.[1] ?? null;
}

// Akamai's error pages write "Reference #" as "Reference&#32;&#35;".
function decodeEntities(s: string): string {
  const char = (code: number, raw: string) => (code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : raw);
  return s
    .replace(/&#x([0-9a-f]{1,6});/gi, (raw, hex) => char(parseInt(hex, 16), raw))
    .replace(/&#(\d{1,7});/g, (raw, dec) => char(Number(dec), raw))
    .replace(/&amp;/g, "&");
}
