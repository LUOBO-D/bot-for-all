import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeSafeAgent, safeFetch, safeLookup, UNSAFE_ADDRESS_CODE } from '../src/bot/safe-fetch';
import { isMetadataAddress } from '../src/bot/url';
import { config } from '../src/config';

const originalAllowPrivate = config.allowPrivateBotUrls;

let server: http.Server;
let baseUrl = '';

beforeAll(async () => {
  server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('provider-ok');
  });
  const listening = Promise.withResolvers<void>();
  server.listen(0, '127.0.0.1', listening.resolve);
  await listening.promise;
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  config.allowPrivateBotUrls = originalAllowPrivate;
});

afterAll(async () => {
  config.allowPrivateBotUrls = originalAllowPrivate;
  await closeSafeAgent();
  const closed = Promise.withResolvers<void>();
  server.close((error) => (error ? closed.reject(error) : closed.resolve()));
  await closed.promise;
});

function resolveOne(hostname: string): Promise<{ address: string; family: number }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ address: string; family: number }>();
  safeLookup(hostname, {}, (error, address, family) => {
    if (error) {
      reject(error);
    } else if (typeof address !== 'string') {
      reject(new Error('expected a single address'));
    } else {
      resolve({ address, family: family ?? 0 });
    }
  });
  return promise;
}

function resolveAll(hostname: string): Promise<string[]> {
  const { promise, resolve, reject } = Promise.withResolvers<string[]>();
  safeLookup(hostname, { all: true }, (error, addresses) => {
    if (error) {
      reject(error);
      return;
    }
    resolve(Array.isArray(addresses) ? addresses.map((entry) => entry.address) : []);
  });
  return promise;
}

describe('isMetadataAddress', () => {
  it('recognises the metadata address in every spelling resolvers accept', () => {
    for (const address of [
      '169.254.169.254',
      '2852039166', // inet_aton decimal
      '0xa9fea9fe', // inet_aton hex
      '::ffff:169.254.169.254',
      '::ffff:a9fe:a9fe',
    ]) {
      expect(isMetadataAddress(address), address).toBe(true);
    }
  });

  it('does not flag other addresses or unparseable input', () => {
    for (const address of ['1.1.1.1', '127.0.0.1', '169.254.169.253', 'example.com', '', '::1']) {
      expect(isMetadataAddress(address), address).toBe(false);
    }
  });
});

describe('safeLookup', () => {
  it('refuses every resolved address when private bot URLs are disabled', async () => {
    config.allowPrivateBotUrls = false;

    await expect(resolveOne('localhost')).rejects.toMatchObject({ code: UNSAFE_ADDRESS_CODE });
    await expect(resolveAll('localhost')).rejects.toMatchObject({ code: UNSAFE_ADDRESS_CODE });
  });

  it('allows loopback when private bot URLs are enabled', async () => {
    config.allowPrivateBotUrls = true;

    const one = await resolveOne('localhost');
    // CI 的 /etc/hosts 可能把 localhost 解析成 ::1；两者都是合法 loopback。
    expect(['127.0.0.1', '::1']).toContain(one.address);
    expect(one.family).toBe(one.address === '::1' ? 6 : 4);

    const all = await resolveAll('localhost');
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((address) => address === '127.0.0.1' || address === '::1')).toBe(true);
  });

  it('refuses metadata addresses even when private bot URLs are enabled', async () => {
    config.allowPrivateBotUrls = true;

    for (const hostname of ['169.254.169.254', '2852039166', '0xa9fea9fe']) {
      await expect(resolveOne(hostname), hostname).rejects.toMatchObject({
        code: UNSAFE_ADDRESS_CODE,
      });
    }
  });

  it('passes DNS failures through untouched', async () => {
    const error: unknown = await resolveOne('bot-provider.invalid').catch((failure: unknown) => failure);

    expect(error).toBeInstanceOf(Error);
    expect((error as NodeJS.ErrnoException).code).toBe('ENOTFOUND');
  });
});

describe('safeFetch', () => {
  it('reaches a loopback provider when private bot URLs are enabled', async () => {
    config.allowPrivateBotUrls = true;

    const response = await safeFetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('provider-ok');
  });

  it('refuses a loopback URL literal when private bot URLs are disabled', async () => {
    config.allowPrivateBotUrls = false;

    await expect(safeFetch(`${baseUrl}/v1/chat/completions`)).rejects.toThrow(/blocked/i);
  });

  it('reaches a provider through the validating lookup', async () => {
    config.allowPrivateBotUrls = true;

    // `localhost` is not an IP literal, so this connection goes through
    // `safeLookup` before the socket is opened.
    const response = await safeFetch(`http://localhost:${new URL(baseUrl).port}/v1/chat/completions`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('provider-ok');
  });

  it('refuses hostnames whose only resolved address is blocked', async () => {
    config.allowPrivateBotUrls = false;

    // Nothing listens on this port: the lookup rejects before a socket exists.
    const failure = (await safeFetch('http://localhost:45999/').catch(
      (error: unknown) => error,
    )) as Error & { cause?: NodeJS.ErrnoException };

    expect(failure).toBeInstanceOf(TypeError);
    expect(failure.cause?.code).toBe(UNSAFE_ADDRESS_CODE);
  });

  it('refuses metadata URLs whatever the private URL setting is', async () => {
    for (const allowPrivate of [true, false]) {
      config.allowPrivateBotUrls = allowPrivate;
      await expect(safeFetch('http://169.254.169.254/latest/meta-data')).rejects.toThrow(/blocked/i);
    }
  });
});
