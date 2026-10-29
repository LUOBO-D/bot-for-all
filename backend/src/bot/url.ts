import { lookup } from 'node:dns/promises';
import { isIPv4, isIPv6 } from 'node:net';
import { config } from '../config';
import { ApiError } from '../errors';

/**
 * Hosts that are rejected even when private bot URLs are allowed: cloud metadata
 * endpoints and the wildcard/unspecified addresses.
 */
const ALWAYS_BLOCKED_HOSTS: Record<string, true> = {
  '0.0.0.0': true,
  '::': true,
  '169.254.169.254': true,
  'metadata.google.internal': true,
};

const METADATA_IPV4 = [169, 254, 169, 254];

function unsafe(message: string): ApiError {
  return new ApiError(400, 'UNSAFE_BOT_URL', message);
}

function ipv4Bytes(address: string): number[] | null {
  if (!isIPv4(address)) {
    return null;
  }
  return address.split('.').map((part) => Number(part));
}

function ipv6Bytes(address: string): number[] | null {
  if (!isIPv6(address)) {
    return null;
  }
  const zoneIndex = address.indexOf('%');
  const addressWithoutZone = zoneIndex === -1 ? address : address.slice(0, zoneIndex);
  const [left, right] = addressWithoutZone.split('::');

  const parseGroups = (part: string): number[] => {
    if (!part) {
      return [];
    }
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (group.includes('.')) {
        const embedded = group.split('.').map(Number);
        groups.push((embedded[0] << 8) | embedded[1], (embedded[2] << 8) | embedded[3]);
      } else {
        groups.push(Number.parseInt(group, 16));
      }
    }
    return groups;
  };

  const head = parseGroups(left ?? '');
  const tail = right === undefined ? [] : parseGroups(right);
  const padding = 8 - head.length - tail.length;
  if (padding < 0) {
    return null;
  }
  const groups = right === undefined ? head : [...head, ...new Array<number>(padding).fill(0), ...tail];
  if (groups.length !== 8) {
    return null;
  }
  const bytes: number[] = [];
  for (const group of groups) {
    bytes.push((group >> 8) & 0xff, group & 0xff);
  }
  return bytes;
}

/** Returns the IPv4 address embedded in an IPv4-mapped/compatible IPv6 address. */
function effectiveIpv4(address: string): number[] | null {
  const direct = ipv4Bytes(address);
  if (direct) {
    return direct;
  }
  const bytes = ipv6Bytes(address);
  if (!bytes) {
    return null;
  }
  const mapped = bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  return mapped || compatible ? bytes.slice(12) : null;
}

function isBlockedIpv4(bytes: number[]): boolean {
  const [a, b] = bytes;
  return (
    a === 0 || // 0.0.0.0/8 (unspecified)
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8 (loopback)
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT)
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local + metadata)
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    a >= 224 // 224.0.0.0/4 multicast and 240.0.0.0/4 reserved
  );
}

function isBlockedIpv6(bytes: number[]): boolean {
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  if (mapped) {
    return isBlockedIpv4(bytes.slice(12));
  }
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if (compatible) {
    // Covers ::, ::1 and the deprecated IPv4-compatible ::a.b.c.d range.
    return isBlockedIpv4(bytes.slice(12));
  }
  if ((bytes[0] & 0xfe) === 0xfc) {
    return true; // fc00::/7 unique local
  }
  if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) {
    return true; // fe80::/10 link-local
  }
  return bytes[0] === 0xff; // ff00::/8 multicast
}

/** True when the address is loopback, private, link-local, CGNAT, multicast or unspecified. */
export function isBlockedAddress(address: string): boolean {
  const v4 = ipv4Bytes(address);
  if (v4) {
    return isBlockedIpv4(v4);
  }
  const v6 = ipv6Bytes(address);
  if (v6) {
    return isBlockedIpv6(v6);
  }
  return true; // unparseable address: fail closed
}

function isMetadataTarget(hostname: string): boolean {
  if (ALWAYS_BLOCKED_HOSTS[hostname]) {
    return true;
  }
  const v4 = effectiveIpv4(hostname);
  return v4 != null && v4.every((byte, index) => byte === METADATA_IPV4[index]);
}

export interface BotUrlOptions {
  /** Defaults to `config.allowPrivateBotUrls`. */
  allowPrivate?: boolean;
}

/**
 * Rejects bot base URLs that would let an operator reach internal services (SSRF).
 * Throws `ApiError(400, 'UNSAFE_BOT_URL')`.
 */
export async function assertSafeBotUrl(
  raw: string,
  options: BotUrlOptions = {},
): Promise<void> {
  const allowPrivate = options.allowPrivate ?? config.allowPrivateBotUrls;

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw unsafe('Bot base URL is not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw unsafe('Bot base URL must use http or https');
  }

  // WHATWG URL keeps IPv6 brackets and trailing dots; normalize both before checks.
  const bracketed = url.hostname;
  const hostname = (bracketed.startsWith('[') ? bracketed.slice(1, -1) : bracketed)
    .replace(/\.$/, '')
    .toLowerCase();
  if (hostname.length === 0) {
    throw unsafe('Bot base URL must include a host');
  }
  if (isMetadataTarget(hostname)) {
    throw unsafe(`Bot base URL host is not allowed: ${hostname}`);
  }
  if (allowPrivate) {
    return;
  }

  if (isIPv4(hostname) || isIPv6(hostname)) {
    if (isBlockedAddress(hostname)) {
      throw unsafe(`Bot base URL points at a private or reserved address: ${hostname}`);
    }
    return;
  }

  let resolved: { address: string }[];
  try {
    resolved = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw unsafe(`Bot base URL host cannot be resolved: ${hostname}`);
  }
  if (resolved.length === 0) {
    throw unsafe(`Bot base URL host cannot be resolved: ${hostname}`);
  }
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address)) {
      throw unsafe(`Bot base URL resolves to a private or reserved address: ${entry.address}`);
    }
  }
}
