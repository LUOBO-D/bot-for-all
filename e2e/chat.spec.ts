import { expect, test, type Page } from '@playwright/test';

const PASSWORD = 'password123';

async function register(page: Page, username: string): Promise<void> {
  await page.goto('/register');
  await page.getByTestId('username').fill(username);
  await page.getByTestId('password').fill(PASSWORD);
  await page.getByTestId('display-name').fill(username);
  await page.getByTestId('register-submit').click();
  await page.waitForURL('**/rooms');
}

async function createRoom(page: Page, name: string): Promise<void> {
  await page.getByTestId('create-room').click();
  await page.getByTestId('room-name').fill(name);
  await page.getByTestId('create-room-submit').click();
  await page.waitForURL(/\/rooms\/\d+$/);
}

async function send(page: Page, content: string): Promise<void> {
  const composer = page.getByTestId('composer');
  await expect(composer).toBeEnabled();
  await composer.fill(content);
  await expect(composer).toHaveValue(content);
  const button = page.getByTestId('send');
  await expect(button).toBeEnabled();
  await button.click();
}

async function socketCall(page: Page, method: 'disconnect' | 'connect'): Promise<void> {
  await page.evaluate((action) => {
    const socket = (window as unknown as {
      __socket?: { disconnect(): void; connect(): void };
    }).__socket;
    if (!socket) {
      throw new Error('__socket is not exposed in DEV');
    }
    socket[action]();
  }, method);
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __socket?: { connected: boolean } }).__socket
            ?.connected ?? false,
      ),
    )
    .toBe(method === 'connect');
}

test('two users chat, reconnect gap fill, bot streams', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const userA = `e2e_a_${suffix}`;
  const userB = `e2e_b_${suffix}`;
  const roomName = `e2e-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, userA);
  await createRoom(pageA, roomName);
  const roomUrl = pageA.url();
  const roomId = Number(roomUrl.split('/').pop());

  await register(pageB, userB);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await send(pageA, 'hello');
  await expect(pageA.getByTestId('message').filter({ hasText: 'hello' })).toHaveCount(1);
  await expect(pageB.getByTestId('message').filter({ hasText: 'hello' })).toHaveCount(1);

  await send(pageB, 'hi');
  await expect(pageA.getByTestId('message').filter({ hasText: 'hi' })).toHaveCount(1);

  await socketCall(pageB, 'disconnect');
  await send(pageA, 'm1');
  await send(pageA, 'm2');
  await socketCall(pageB, 'connect');

  await expect(pageB.getByTestId('message').filter({ hasText: 'm1' })).toHaveCount(1);
  await expect(pageB.getByTestId('message').filter({ hasText: 'm2' })).toHaveCount(1);

  const token = await pageA.evaluate(() => localStorage.getItem('bfa_token'));
  expect(token).toBeTruthy();

  const response = await pageA.request.post('http://127.0.0.1:3000/api/me/bots', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: 'e2e-bot',
      roomId,
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-ok',
      triggerMode: 'mention',
    },
  });
  expect(response.ok()).toBeTruthy();
  const payload: unknown = await response.json();
  const botUsername =
    typeof payload === 'object' &&
    payload !== null &&
    'bot' in payload &&
    typeof payload.bot === 'object' &&
    payload.bot !== null &&
    'username' in payload.bot &&
    typeof payload.bot.username === 'string'
      ? payload.bot.username
      : '';
  expect(botUsername).toMatch(/^bot_/);

  await send(pageA, `@${botUsername} 你好`);
  await expect(pageA.getByTestId('message').filter({ hasText: '你好，世界' })).toHaveCount(1);
  await expect(pageB.getByTestId('message').filter({ hasText: '你好，世界' })).toHaveCount(1);

  await contextA.close();
  await contextB.close();
});

test('creates a bot through the UI and mentions it', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const username = `e2e_bot_${suffix}`;
  const roomName = `e2e-bot-room-${suffix}`;

  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, username);
  await createRoom(page, roomName);

  await page.getByRole('button', { name: '机器人' }).click();
  await page.getByTestId('bot-name').fill('ui-bot');
  await page.getByTestId('bot-base-url').fill('http://127.0.0.1:4010');
  await page.getByTestId('bot-api-key').fill('test-key');
  await page.getByTestId('bot-model').fill('fake-ok');
  await page.getByTestId('bot-create').click();

  const botRow = page.locator('.bot-card', { hasText: 'ui-bot' });
  await expect(botRow).toBeVisible();
  const subText = (await botRow.locator('.bot-card-sub').textContent()) ?? '';
  const match = subText.match(/@(bot_[a-f0-9]+)/);
  expect(match).not.toBeNull();
  const botUsername = match?.[1] ?? '';

  await page.keyboard.press('Escape');
  await expect(page.locator('.member-row', { hasText: 'ui-bot' })).toBeVisible();

  await send(page, `@${botUsername} 你好`);
  await expect(page.getByTestId('message').filter({ hasText: '你好，世界' })).toHaveCount(1);

  await context.close();
});

test('message reactions, edit, pin and delete', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_act_${suffix}`);
  await createRoom(page, `act-room-${suffix}`);
  await send(page, 'action target');

  let message = page
    .getByTestId('message')
    .filter({ hasText: 'action target' })
    .last();
  await message.hover();
  await message.getByRole('button', { name: '表情' }).click();
  await message.locator('.msg-emoji-item').first().click();
  await expect(message.locator('.reaction-chip')).toHaveCount(1);

  await message.getByRole('button', { name: '编辑' }).click();
  await page.getByTestId('composer').fill('action edited');
  await page.getByTestId('send').click();

  message = page.getByTestId('message').filter({ hasText: 'action edited' }).last();
  await expect(message.locator('.msg-mark').filter({ hasText: '已编辑' })).toBeVisible();

  await message.hover();
  await message.getByRole('button', { name: '置顶' }).click();
  await page.getByRole('button', { name: '置顶消息' }).click();
  await expect(
    page.locator('.pin-card').filter({ hasText: 'action edited' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');

  await message.hover();
  await message.getByRole('button', { name: '删除' }).click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(page.locator('.msg.deleted').filter({ hasText: '消息已撤回' })).toBeVisible();

  await context.close();
});

test('command palette and room search', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_cmd_${suffix}`);
  await createRoom(page, `cmd-room-${suffix}`);
  await send(page, 'searchable needle');

  await page.keyboard.press('Control+K');
  await expect(page.locator('.cmdk')).toBeVisible();
  await page.locator('.cmdk-input input').fill(`cmd-room-${suffix}`);
  await expect(
    page.locator('.cmdk-item').filter({ hasText: `cmd-room-${suffix}` }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cmdk')).toHaveCount(0);

  await page.getByRole('button', { name: '搜索消息' }).click();
  await page.locator('.room-search-bar input').fill('needle');
  await expect(page.locator('.search-result')).toHaveCount(1);
  await page.locator('.search-result').click();
  await expect(page.locator('.msg.highlight')).toHaveCount(1);

  await context.close();
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('message actions work on a 390px screen', async ({ browser }) => {
    const suffix = Date.now().toString().slice(-8);
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    await register(page, `e2e_m_${suffix}`);
    await createRoom(page, `m-room-${suffix}`);
    await send(page, 'mobile target');

    const message = page
      .getByTestId('message')
      .filter({ hasText: 'mobile target' })
      .last();
    await expect(message.getByRole('button', { name: '消息操作' })).toBeVisible();
    await message.getByRole('button', { name: '消息操作' }).click();
    await expect(message.getByRole('button', { name: '回复' })).toBeVisible();
    await expect(message.getByRole('button', { name: '复制' })).toBeVisible();

    await message.getByRole('button', { name: '回复' }).click();
    await expect(page.locator('.reply-bar')).toBeVisible();
    await page.getByTestId('composer').fill('mobile reply');
    await page.getByTestId('send').click();

    const reply = page
      .getByTestId('message')
      .filter({ hasText: 'mobile reply' })
      .last();
    await expect(reply).toBeVisible();
    await expect(reply.locator('.reply-quote')).toBeVisible();
    await expect(page.locator('.reply-bar')).toHaveCount(0);

    await context.close();
  });
});
