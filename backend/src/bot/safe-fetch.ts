import { lookup, type LookupAddress, type LookupOptions } from 'node:dns';
import { isIPv4, isIPv6, type LookupFunction } from 'node:net';
import {
  Agent,
  fetch as undiciFetch,
  type RequestInit as DispatcherRequestInit,
} from 'undici';
import { config } from '../config';
import { isBlockedAddress, isMetadataAddress } from './url';

/** Error code used when every resolved address of a bot provider host is refused. */
export const UNSAFE_ADDRESS_CODE = 'EUNSAFEADDRESS';

export type SafeLookupCallback = (
  error: NodeJS.ErrnoException | null,
  address?: string | LookupAddress[],
  family?: number,
) => void;

function blockedError(hostname: string, addresses: string[]): NodeJS.ErrnoException {
  const error = new Error(
    `Bot provider host ${hostname} resolves to blocked addresses: ${addresses.join(', ') || 'none'}`,
  ) as NodeJS.ErrnoException;
  error.code = UNSAFE_ADDRESS_CODE;
  return error;
}

/**
 * `dns.lookup` replacement handed to the dispatcher: the addresses it returns
 * are the addresses the socket connects to, so validation and connection share
 * one resolution and a DNS rebind between check and connect is impossible.
 *
 * Cloud metadata addresses are always refused; private/reserved addresses are
 * refused unless `config.allowPrivateBotUrls` is set.
 */
export function safeLookup(
  hostname: string,
  options: LookupOptions,
  callback: SafeLookupCallback,
): void {
  lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error);
      return;
    }
    if (addresses.length === 0) {
      callback(blockedError(hostname, []));
      return;
    }
    const allowPrivate = config.allowPrivateBotUrls;
    const safe = addresses.filter(
      (entry) => !isMetadataAddress(entry.address) && (allowPrivate || !isBlockedAddress(entry.address)),
    );
    if (safe.length === 0) {
      callback(
        blockedError(
          hostname,
          addresses.map((entry) => entry.address),
        ),
      );
      return;
    }
    if (options.all === true) {
      callback(null, safe);
      return;
    }
    const [first] = safe;
    callback(null, first.address, first.family);
  });
}

// `LookupFunction` claims the address argument is always present; on the error
// path `dns.lookup` only passes the error, hence the narrow assertion.
const dispatcher = new Agent({ connect: { lookup: safeLookup as LookupFunction } });

/**
 * Refuses URL literals the dispatcher lookup never sees: `net.connect` skips
 * `lookup` when the host is already an IP address.
 */
function literalBlockReason(hostname: string): string | null {
  const bare = (hostname.startsWith('[') ? hostname.slice(1, -1) : hostname)
    .replace(/\.$/, '')
    .toLowerCase();
  if (!isIPv4(bare) && !isIPv6(bare)) {
    return null;
  }
  if (isMetadataAddress(bare) || (!config.allowPrivateBotUrls && isBlockedAddress(bare))) {
    return `Bot provider address is blocked: ${bare}`;
  }
  return null;
}

/**
 * `fetch` for bot providers. Every request (and every redirect hop the caller
 * follows) goes through the address-validating dispatcher.
 */
export async function safeFetch(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const target = new URL(input);
  const reason = literalBlockReason(target.hostname);
  if (reason !== null) {
    throw new Error(reason);
  }
  // undici ships its own DOM typings; at runtime it accepts Node's `RequestInit`
  // unchanged, so these assertions only bridge the two type definitions.
  const requestInit = { ...init, dispatcher } as unknown as DispatcherRequestInit;
  return (await undiciFetch(input, requestInit)) as unknown as Response;
}

let closing: Promise<void> | null = null;

/** Closes the shared dispatcher; repeated calls share the same shutdown. */
export function closeSafeAgent(): Promise<void> {
  closing ??= dispatcher.close().then(() => undefined);
  return closing;
}
