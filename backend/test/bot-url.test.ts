import { describe, expect, it } from 'vitest';
import { assertSafeBotUrl, isBlockedAddress } from '../src/bot/url';
import { createBot, getBotById, updateBot } from '../src/services/bot';
import { createTestRoom, createTestUser } from './helpers';

async function expectUnsafe(url: string, allowPrivate?: boolean): Promise<void> {
  await expect(assertSafeBotUrl(url, { allowPrivate })).rejects.toMatchObject({
    code: 'UNSAFE_BOT_URL',
  });
}

describe('assertSafeBotUrl', () => {
  it('always rejects cloud metadata targets, even when private URLs are allowed', async () => {
    await expectUnsafe('http://169.254.169.254/latest/meta-data', true);
    await expectUnsafe('http://169.254.169.254', true);
    await expectUnsafe('http://metadata.google.internal/computeMetadata/v1', true);
    await expectUnsafe('http://0.0.0.0:8080', true);
    await expectUnsafe('http://[::]:8080', true);
    await expectUnsafe('http://[::ffff:169.254.169.254]/', true);
  });

  it('rejects loopback unless private URLs are allowed', async () => {
    await expectUnsafe('http://127.0.0.1:11434', false);
    await expect(assertSafeBotUrl('http://127.0.0.1:11434', { allowPrivate: true })).resolves.toBeUndefined();
  });

  it('rejects private, link-local, CGNAT and multicast IPv4 ranges', async () => {
    for (const host of [
      '10.1.2.3',
      '172.16.0.1',
      '172.31.255.254',
      '192.168.1.10',
      '169.254.1.1',
      '100.64.0.1',
      '100.127.255.255',
      '224.0.0.1',
      '255.255.255.255',
    ]) {
      await expectUnsafe(`http://${host}:8080`, false);
    }
  });

  it('rejects private and loopback IPv6 ranges', async () => {
    for (const host of ['[::1]', '[fc00::1]', '[fd12:3456::1]', '[fe80::1]', '[::ffff:127.0.0.1]']) {
      await expectUnsafe(`http://${host}:8080`, false);
    }
  });

  it('allows public addresses and hostnames that are not private', async () => {
    await expect(
      assertSafeBotUrl('http://93.184.216.34:8080', { allowPrivate: false }),
    ).resolves.toBeUndefined();
    await expect(
      assertSafeBotUrl('https://api.openai.com', { allowPrivate: true }),
    ).resolves.toBeUndefined();
  });

  it('rejects non-http protocols and malformed URLs', async () => {
    await expectUnsafe('ftp://example.com', true);
    await expectUnsafe('file:///etc/passwd', true);
    await expectUnsafe('not a url', true);
    await expectUnsafe('http://', true);
  });

  it('classifies individual addresses', () => {
    expect(isBlockedAddress('8.8.8.8')).toBe(false);
    expect(isBlockedAddress('127.0.0.1')).toBe(true);
    expect(isBlockedAddress('10.0.0.1')).toBe(true);
    expect(isBlockedAddress('::1')).toBe(true);
    expect(isBlockedAddress('2606:4700:4700::1111')).toBe(false);
    expect(isBlockedAddress('::ffff:10.0.0.1')).toBe(true);
    expect(isBlockedAddress('nonsense')).toBe(true);
  });
});

describe('bot URL enforcement in the bot service', () => {
  it('rejects a metadata baseUrl when creating a bot', async () => {
    const owner = await createTestUser('ssrf_owner');
    const roomId = await createTestRoom(owner);

    await expect(
      createBot({
        actor: owner,
        scope: 'room',
        roomId,
        name: 'ssrf-bot',
        baseUrl: 'http://169.254.169.254',
        apiKey: 'test-key',
        model: 'fake-ok',
      }),
    ).rejects.toMatchObject({ code: 'UNSAFE_BOT_URL' });
  });

  it('allows a loopback baseUrl when ALLOW_PRIVATE_BOT_URLS is enabled', async () => {
    const owner = await createTestUser('loopback_owner');
    const roomId = await createTestRoom(owner);

    const bot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'loopback-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });
    expect((await getBotById(bot.userId)).baseUrl).toBe('http://127.0.0.1:4010');
  });

  it('rejects a metadata baseUrl when updating a bot', async () => {
    const owner = await createTestUser('ssrf_update_owner');
    const roomId = await createTestRoom(owner);
    const bot = await createBot({
      actor: owner,
      scope: 'room',
      roomId,
      name: 'ssrf-update-bot',
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
    });

    await expect(
      updateBot(bot.userId, owner, { baseUrl: 'http://metadata.google.internal' }),
    ).rejects.toMatchObject({ code: 'UNSAFE_BOT_URL' });
    expect((await getBotById(bot.userId)).baseUrl).toBe('http://127.0.0.1:4010');
  });
});
