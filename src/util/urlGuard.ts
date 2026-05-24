// SSRF + scheme guard for outbound HTTP from agent tools. Blocks:
//   - non-http(s) schemes (file://, javascript:, data:, etc.)
//   - hostnames literally pointing at metadata / loopback / local TLDs
//   - hostnames resolving to private / link-local / loopback IP ranges
//
// Why we do this here and not at the OS firewall: autocode ships to
// Automax V6 users who run on laptops, EC2 instances, corporate
// networks. Without the guard, a prompt-injected agent could fetch
// http://169.254.169.254/latest/meta-data/iam/security-credentials/…
// and leak the user's AWS credentials. The guard makes the agent's
// outbound HTTP have meaningfully smaller blast radius.
//
// Zero impact on legitimate public web fetches.

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export interface UrlGuardConfig {
  /** Allow http:// in addition to https://. Default false. */
  allowHttp?: boolean;
  /** Reject hostnames resolving to private IP ranges. Default true. */
  blockPrivateIps?: boolean;
  /** Extra hostnames to block (exact, case-insensitive match on the hostname). */
  extraBlockedHosts?: string[];
  /** Hostnames that override the built-in blocklist — escape hatch. */
  extraAllowedHosts?: string[];
}

export interface UrlVerdict {
  ok: boolean;
  /** Human-readable rejection reason — surfaced to the LLM as a tool error. */
  reason?: string;
}

// Hard-coded nasties — always blocked unless the host is explicitly in
// extraAllowedHosts. Short by design; broader blocking is the user's
// extraBlockedHosts list.
const BAKED_HOST_BLOCKLIST = new Set<string>([
  // Cloud metadata endpoints (the classic SSRF goal).
  '169.254.169.254',           // AWS / GCP / Azure / DigitalOcean
  'metadata.google.internal',
  'metadata.goog',
  'metadata.azure.com',
  'instance-data',             // EC2 short alias
  // Loopback aliases.
  'localhost',
  'localhost.localdomain',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  '[::1]',
]);

// Hostname suffixes that indicate intranet / mDNS / private LAN.
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.intranet', '.localhost'];

export async function validateUrl(input: string, cfg: UrlGuardConfig = {}): Promise<UrlVerdict> {
  // 1. parseable
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: `not a valid URL: ${input}` };
  }

  // 2. scheme allowlist
  const scheme = url.protocol.toLowerCase();
  if (scheme === 'https:' || (scheme === 'http:' && cfg.allowHttp)) {
    // ok
  } else {
    return {
      ok: false,
      reason: `scheme not allowed: ${scheme} (allowed: https${cfg.allowHttp ? ', http' : ''})`,
    };
  }

  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // 3. user override — explicit allow wins over everything below
  const allowSet = new Set((cfg.extraAllowedHosts ?? []).map((h) => h.toLowerCase()));
  if (allowSet.has(hostname)) return { ok: true };

  // 4. baked-in nasties blocklist
  if (BAKED_HOST_BLOCKLIST.has(hostname)) {
    return { ok: false, reason: `host is on the built-in blocklist: ${hostname}` };
  }
  for (const sfx of PRIVATE_SUFFIXES) {
    if (hostname.endsWith(sfx)) {
      return { ok: false, reason: `host has a private suffix (${sfx}): ${hostname}` };
    }
  }

  // 5. extra user blocklist
  const userBlock = new Set((cfg.extraBlockedHosts ?? []).map((h) => h.toLowerCase()));
  if (userBlock.has(hostname)) {
    return { ok: false, reason: `host is on the user blocklist: ${hostname}` };
  }

  // 6. private IP block (resolve via DNS first if needed)
  if (cfg.blockPrivateIps !== false) {
    const ipFamily = isIP(hostname);
    let ips: string[];
    if (ipFamily) {
      ips = [hostname];
    } else {
      try {
        const all = await lookup(hostname, { all: true });
        ips = all.map((a) => a.address);
      } catch (e) {
        // If DNS fails, refuse — we can't verify the target safely.
        return {
          ok: false,
          reason: `DNS lookup failed for ${hostname}: ${e instanceof Error ? e.message : String(e)}`,
        };
      }
    }
    for (const ip of ips) {
      if (isPrivateIp(ip)) {
        return { ok: false, reason: `host resolves to private/loopback IP ${ip} (${hostname})` };
      }
    }
  }

  return { ok: true };
}

// Returns true for any IP in: loopback, RFC1918 private, link-local,
// IPv6 unique-local, IPv6 link-local, IPv6 loopback. Public IPs return false.
export function isPrivateIp(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isPrivateV4(ip);
  if (fam === 6) return isPrivateV6(ip.toLowerCase());
  return false;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number.parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts as [number, number, number, number];
  // 10.0.0.0/8
  if (a === 10) return true;
  // 172.16.0.0/12
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;
  // 127.0.0.0/8 — loopback
  if (a === 127) return true;
  // 169.254.0.0/16 — link-local + AWS metadata
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8 — "this network"
  if (a === 0) return true;
  // 100.64.0.0/10 — CGNAT (often used for internal/VPN ranges)
  if (a === 100 && b >= 64 && b <= 127) return true;
  return false;
}

function isPrivateV6(ip: string): boolean {
  // Strip zone id if present (e.g. "fe80::1%eth0").
  const bare = ip.split('%')[0]!;
  // Loopback ::1
  if (bare === '::1' || bare === '::') return true;
  // Link-local fe80::/10
  if (bare.startsWith('fe8') || bare.startsWith('fe9') || bare.startsWith('fea') || bare.startsWith('feb')) return true;
  // Unique-local fc00::/7
  if (bare.startsWith('fc') || bare.startsWith('fd')) return true;
  // IPv4-mapped: ::ffff:x.x.x.x — re-check as v4
  const v4 = /^::ffff:([\d.]+)$/i.exec(bare);
  if (v4) return isPrivateV4(v4[1]!);
  return false;
}
