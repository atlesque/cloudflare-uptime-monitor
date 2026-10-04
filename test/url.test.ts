import { describe, expect, it } from "vitest";
import { normalizeMonitorUrl } from "../src/url";

describe("monitor URL validation", () => {
  it.each([
    ["https://Example.COM", "https://example.com/"],
    ["http://example.com:80/path?q=1#frag", "http://example.com/path?q=1"],
    ["https://example.com:8443/", "https://example.com:8443/"],
    ["https://8.8.8.8/", "https://8.8.8.8/"],
    ["https://[2606:4700::1111]/", "https://[2606:4700::1111]/"],
  ])("accepts and normalizes %s", (input, expected) => {
    expect(normalizeMonitorUrl(input)).toEqual({ ok: true, url: expected });
  });

  it.each([
    "not a url",
    "ftp://example.com/",
    "https://user:pass@example.com/",
    "http://localhost/",
    "http://app.localhost/",
    "http://printer.local/",
    "http://intranet/",
    "http://127.0.0.1/",
    "http://2130706433/", // 127.0.0.1 in decimal form
    "http://0x7f.1/",
    "http://10.1.2.3/",
    "http://172.20.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://[::1]/",
    "http://[fe80::1]/",
    "http://[fd00::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[2001:db8::1]/",
  ])("rejects %s", (input) => {
    expect(normalizeMonitorUrl(input).ok).toBe(false);
  });
});
