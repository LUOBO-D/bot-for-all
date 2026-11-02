import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

declare global {
  interface Window {
    __socket?: {
      emit: (
        event: string,
        payload: unknown,
        ack?: (res: { ok?: boolean }) => void,
      ) => void;
    };
    __notifications?: { title: string; body?: string }[];
    __notificationInstances?: { onclick: (() => void) | null }[];
    __navUrls?: string[];
    __beeps?: number;
  }
}

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

async function openNotifications(page: Page): Promise<void> {
  const bell = page.getByTestId('notifications-bell');
  const panel = page.getByTestId('notification-panel');
  await bell.click();
  try {
    await expect(panel).toBeVisible({ timeout: 4000 });
  } catch {
    await bell.click();
    await expect(panel).toBeVisible();
  }
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
  // A no-op disconnect would still deliver these over the live socket; make
  // sure nothing arrives before reconnecting (the later gap-fill proves it).
  await pageB.waitForTimeout(300);
  await expect(pageB.getByTestId('message').filter({ hasText: 'm1' })).toHaveCount(0);
  await expect(pageB.getByTestId('message').filter({ hasText: 'm2' })).toHaveCount(0);
  await socketCall(pageB, 'connect');

  await expect(pageB.getByTestId('message').filter({ hasText: 'm1' })).toHaveCount(1);
  await expect(pageB.getByTestId('message').filter({ hasText: 'm2' })).toHaveCount(1);

  const token = await pageA.evaluate(() => localStorage.getItem('bfa_token'));
  expect(token).toBeTruthy();

  const response = await pageA.request.post('/api/me/bots', {
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
  await expect(message.locator('.reaction-chip')).toHaveAttribute(
    'title',
    /e2e_act_/,
  );

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
  await expect(
    page.getByTestId('message').filter({ hasText: 'searchable needle' }).last(),
  ).toBeVisible();

  await page.keyboard.press('Control+K');
  await expect(page.locator('.cmdk')).toBeVisible();
  await page.locator('.cmdk-input input').fill(`cmd-room-${suffix}`);
  await expect(
    page.locator('.cmdk-item').filter({ hasText: `cmd-room-${suffix}` }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.cmdk')).toHaveCount(0);

  await page.getByRole('button', { name: '搜索消息' }).click();
  await expect(page.locator('.room-search-panel')).toBeVisible();
  await page.locator('.room-search-bar input').fill('needle');
  await expect(page.locator('.search-result')).toHaveCount(1);
  await page.locator('.search-result').click();
  await expect(page.locator('.msg.highlight')).toHaveCount(1);

  await context.close();
});

test('room search failure is not reported as no matches', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_serr_${suffix}`);
  await createRoom(page, `serr-room-${suffix}`);
  await send(page, 'search failure needle');
  await expect(
    page.getByTestId('message').filter({ hasText: 'search failure needle' }),
  ).toHaveCount(1);

  await page.route('**/api/rooms/*/search*', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'search unavailable' } }),
    }),
  );

  await page.getByTestId('search-open').click();
  await page.locator('.room-search-bar input').fill('needle');
  await expect(page.getByTestId('search-error')).toBeVisible();
  await expect(page.getByTestId('search-error')).toContainText('搜索失败');
  await expect(page.getByText('没有匹配消息')).toHaveCount(0);

  // The same query recovers once the endpoint does.
  await page.unroute('**/api/rooms/*/search*');
  await page.getByTestId('search-retry').click();
  await expect(page.locator('.search-result')).toHaveCount(1);
  await expect(page.getByTestId('search-error')).toHaveCount(0);

  await context.close();
});

test('filters room search by sender', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_sfilter_a_${suffix}`;
  const member = `e2e_sfilter_b_${suffix}`;
  const roomName = `sfilter-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await send(pageA, 'filter needle from owner');
  await send(pageB, 'filter needle from member');
  await expect(pageA.getByTestId('member-row').filter({ hasText: member })).toBeVisible();

  await pageA.getByRole('button', { name: '搜索消息' }).click();
  await pageA.locator('.room-search-bar input').fill('needle');
  await pageA.locator('.room-search-bar input').press('Enter');
  await expect(pageA.locator('.search-result')).toHaveCount(2);
  await expect(pageA.locator('.search-hit').first()).toHaveText('needle');
  await pageA.getByTestId('search-sender').selectOption({ label: member });
  const memberValue = await pageA.getByTestId('search-sender').inputValue();
  await expect(pageA.locator('.search-result')).toHaveCount(1);
  await expect(pageA.locator('.search-result')).toContainText('from member');
  await pageA.locator('.search-result').click();
  await expect(pageA.locator('.msg.highlight')).toContainText('from member');

  await pageA.getByRole('button', { name: '搜索消息' }).click();
  await expect(pageA.getByTestId('search-recent').filter({ hasText: 'needle' })).toBeVisible();
  await expect(pageA.getByTestId('search-sender')).toHaveValue(memberValue);
  await pageA.getByTestId('search-recent').filter({ hasText: 'needle' }).click();
  await expect(pageA.locator('.search-result')).toHaveCount(1);
  await expect(pageA.locator('.search-result')).toContainText('from member');
  await pageA.locator('.room-search-bar input').fill('');
  await pageA.getByTestId('search-recent-clear').click();
  await expect(pageA.getByTestId('search-recent')).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test('paginates room search results', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_spage_${suffix}`);
  await createRoom(page, `spage-room-${suffix}`);
  const roomId = Number(page.url().split('/').pop());

  await page.evaluate(
    async ({ roomId, count }) => {
      const socket = window.__socket;
      if (!socket) {
        throw new Error('__socket missing');
      }
      for (let index = 0; index < count; index += 1) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        socket.emit(
          'message:send',
          {
            roomId,
            content: `page-needle ${index}`,
            clientMsgId: `page-${index}`,
          },
          (result) => {
            if (result?.ok) {
              resolve();
            } else {
              reject(new Error('send failed'));
            }
          },
        );
        await promise;
      }
    },
    { roomId, count: 25 },
  );

  await page.getByRole('button', { name: '搜索消息' }).click();
  await page.locator('.room-search-bar input').fill('page-needle');
  await expect(page.locator('.search-result')).toHaveCount(20);
  await page.getByTestId('search-load-more').click();
  await expect(page.locator('.search-result')).toHaveCount(25);
  await expect(page.getByTestId('search-load-more')).toHaveCount(0);

  await context.close();
});

test('translates a message from its context menu', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_translate_${suffix}`);
  await createRoom(page, `translate-room-${suffix}`);
  await send(page, 'hello translation');

  const message = page
    .getByTestId('message')
    .filter({ hasText: 'hello translation' })
    .last();
  await message.click({ button: 'right' });
  await expect(page.getByTestId('translate')).toBeVisible();
  await page.getByTestId('translate').click();
  await expect(message.getByTestId('translation')).toContainText('翻译结果');
  await message.getByTestId('translation-lang').selectOption('ja');
  await expect(message.getByTestId('translation-lang')).toHaveValue('ja');
  await expect(message.getByTestId('translation-text')).toHaveText('翻译结果');
  expect(
    await page.evaluate(() => localStorage.getItem('bfa_translate_lang')),
  ).toBe('ja');
  await message.getByTestId('translation-hide').click();
  await expect(message.getByTestId('translation')).toHaveCount(0);

  await context.close();
});

test('message context menu and keyboard shortcuts', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_menu_${suffix}`);
  await createRoom(page, `menu-room-${suffix}`);
  await send(page, 'menu target');

  const message = page
    .getByTestId('message')
    .filter({ hasText: 'menu target' })
    .last();
  await message.click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toBeVisible();
  await expect(page.locator('.ctx-item').filter({ hasText: '回复' })).toBeVisible();
  await expect(page.locator('.ctx-item').filter({ hasText: '复制文本' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctx-menu')).toHaveCount(0);

  await page.keyboard.press('Shift+Slash');
  await expect(page.locator('.shortcuts-panel')).toBeVisible();
  await expect(page.locator('.shortcuts-panel')).toContainText('键盘快捷键');
  await page.keyboard.press('Escape');
  await expect(page.locator('.shortcuts-panel')).toHaveCount(0);

  await page.getByTestId('composer').click();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.edit-bar')).toBeVisible();
  await expect(page.locator('.edit-bar')).toContainText('编辑消息');
  await page.keyboard.press('Escape');
  await expect(page.locator('.edit-bar')).toHaveCount(0);

  await page.keyboard.press('Shift+Escape');
  await expect(page.locator('.el-message').filter({ hasText: '已标记为已读' })).toBeVisible();

  await context.close();
});

test('room owner promotes and kicks a member', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_own_${suffix}`;
  const member = `e2e_mem_${suffix}`;
  const roomName = `own-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  const memberRow = pageA
    .locator('[data-testid=member-row]')
    .filter({ hasText: member });
  await expect(memberRow).toBeVisible();

  await memberRow.click({ button: 'right' });
  await pageA.getByTestId('member-role').click();
  await expect(memberRow.locator('.role-tag')).toHaveText('管理员');

  await memberRow.click({ button: 'right' });
  await pageA.getByTestId('member-kick').click();
  await expect(memberRow).toHaveCount(0);
  await pageB.waitForURL(/\/rooms$/);

  await contextA.close();
  await contextB.close();
});

test('room announcement broadcasts and mute hides unread badge', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const roomName = `meta-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, `e2e_meta_a_${suffix}`);
  await createRoom(pageA, roomName);
  await register(pageB, `e2e_meta_b_${suffix}`);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await pageA.getByTitle('房间设置').click();
  const settings = pageA.locator('.el-dialog').filter({ hasText: '房间设置' });
  await settings.getByRole('textbox', { name: '公告' }).fill('今晚 8 点发布新版本');
  await settings.getByRole('button', { name: '保存' }).click();

  await expect(pageA.getByTestId('room-announcement')).toContainText('今晚 8 点发布新版本');
  await expect(pageB.getByTestId('room-announcement')).toContainText('今晚 8 点发布新版本');

  await pageA.getByLabel('关闭公告').click();
  await expect(pageA.getByTestId('room-announcement')).toHaveCount(0);
  await pageA.reload();
  await expect(pageA.getByTestId('room-announcement')).toHaveCount(0);

  await pageA.getByTitle('房间设置').click();
  const nextSettings = pageA.locator('.el-dialog').filter({ hasText: '房间设置' });
  await nextSettings.getByRole('textbox', { name: '公告' }).fill('明晚 9 点维护');
  await nextSettings.getByRole('button', { name: '保存' }).click();
  await expect(pageA.getByTestId('room-announcement')).toContainText('明晚 9 点维护');
  await expect(pageB.getByTestId('room-announcement')).toContainText('明晚 9 点维护');

  await pageA.getByTitle('房间设置').click();
  const muteDialog = pageA.locator('.el-dialog').filter({ hasText: '消息免打扰' });
  await muteDialog.locator('input[type=checkbox]').check();
  await expect(pageA.getByTestId('room-muted')).toBeVisible();
  await muteDialog.getByRole('button', { name: '关闭' }).click();

  await contextA.close();
  await contextB.close();
});

test('persists a room message retention window', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_ret_${suffix}`);
  await createRoom(page, `retention-room-${suffix}`);

  await page.getByTitle('房间设置').click();
  let settings = page.locator('.el-dialog').filter({ hasText: '房间设置' });
  await expect(settings.getByTestId('retention-preview')).toContainText('永久保留');
  await settings.getByTestId('retention-days').fill('30');
  await expect(settings.getByTestId('retention-preview')).toContainText(
    '暂无可清理消息',
  );
  await settings.getByRole('button', { name: '保存' }).click();
  await expect(page.locator('.el-message').filter({ hasText: '已保存' })).toBeVisible();

  await page.reload();
  await page.getByTitle('房间设置').click();
  settings = page.locator('.el-dialog').filter({ hasText: '房间设置' });
  await expect(settings.getByTestId('retention-days')).toHaveValue('30');

  await context.close();
});

test('uploads and removes a user avatar', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_avatar_${suffix}`);
  await createRoom(page, `avatar-room-${suffix}`);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64',
  );

  await page.getByTitle('个人设置').click();
  let profile = page.locator('.el-dialog').filter({ hasText: '个人设置' });
  await profile.getByTestId('avatar-input').setInputFiles({
    name: 'avatar.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.locator('.el-message').filter({ hasText: '头像已更新' })).toBeVisible();

  const image = profile.locator('.profile-head img.avatar-img');
  await expect(image).toBeVisible();
  const src = await image.getAttribute('src');
  expect(src).toMatch(/^\/api\/users\/\d+\/avatar\?v=[0-9a-f]{32}$/);
  const fetched = await page.request.get(new URL(src ?? '', page.url()).toString());
  expect(fetched.status()).toBe(200);
  expect(fetched.headers()['content-type']).toBe('image/png');

  await page.reload();
  await page.getByTitle('个人设置').click();
  profile = page.locator('.el-dialog').filter({ hasText: '个人设置' });
  await expect(profile.locator('.profile-head img.avatar-img')).toBeVisible();

  await profile.getByTestId('avatar-remove').click();
  await expect(page.locator('.el-message').filter({ hasText: '头像已移除' })).toBeVisible();
  await expect(profile.locator('.profile-head img.avatar-img')).toHaveCount(0);

  await page.reload();
  await page.getByTitle('个人设置').click();
  profile = page.locator('.el-dialog').filter({ hasText: '个人设置' });
  await expect(profile.locator('.profile-head img.avatar-img')).toHaveCount(0);

  await context.close();
});

test('global message search jumps across rooms', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const needle = `needle${suffix}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_search_${suffix}`);
  await createRoom(page, `search-a-${suffix}`);
  await send(page, `alpha ${needle} one`);

  await page.goto('/rooms');
  await createRoom(page, `search-b-${suffix}`);
  await send(page, `beta ${needle} two`);
  await expect(
    page.getByTestId('message').filter({ hasText: `beta ${needle} two` }).last(),
  ).toBeVisible();

  await page.keyboard.press('Control+K');
  await page.locator('.cmdk-input input').fill(needle);
  await expect(page.getByTestId('cmdk-message')).toHaveCount(2);

  await page
    .getByTestId('cmdk-message')
    .filter({ hasText: `alpha ${needle}` })
    .click();
  await expect(page.locator('.msg.highlight')).toContainText(`alpha ${needle}`);
  await expect.poll(() => page.url()).not.toContain('seq=');

  await context.close();
});

test('forwards a message to another room', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_fwd_${suffix}`);
  const sourceRoom = `fwd-src-${suffix}`;
  await createRoom(page, sourceRoom);
  const sourceUrl = page.url();
  await send(page, 'forward this message');

  await page.goto('/rooms');
  const targetRoom = `fwd-dst-${suffix}`;
  await createRoom(page, targetRoom);
  const targetUrl = page.url();

  await page.goto(sourceUrl);
  const message = page
    .getByTestId('message')
    .filter({ hasText: 'forward this message' })
    .last();
  await message.click({ button: 'right' });
  await page.getByTestId('forward').click();
  await expect(page.getByTestId('forward-dialog')).toBeVisible();
  await page.getByTestId('forward-room').filter({ hasText: targetRoom }).click();
  await expect(page.getByTestId('forward-dialog')).toHaveCount(0);

  await page.goto(targetUrl);
  const forwarded = page
    .getByTestId('message')
    .filter({ hasText: 'forward this message' })
    .last();
  await expect(forwarded.locator('.forward-tag')).toContainText(`转发自 ${sourceRoom}`);

  await context.close();
});

test('forwards multiple selected messages to another room', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_fwdbulk_${suffix}`);
  const sourceRoom = `bulk-src-${suffix}`;
  await createRoom(page, sourceRoom);
  const sourceUrl = page.url();
  await send(page, 'bulk forward one');
  await send(page, 'bulk forward two');

  await page.goto('/rooms');
  const targetRoom = `bulk-dst-${suffix}`;
  await createRoom(page, targetRoom);
  const targetUrl = page.url();

  await page.goto(sourceUrl);
  await page.getByTestId('select-mode').click();
  for (const text of ['bulk forward one', 'bulk forward two']) {
    const row = page.getByTestId('message').filter({ hasText: text }).last();
    await row.getByTestId('message-select').check();
  }
  await expect(page.getByTestId('selected-count')).toContainText('2');
  await page.getByTestId('bulk-forward').click();
  await expect(page.getByTestId('forward-dialog')).toBeVisible();
  await expect(page.getByTestId('forward-count')).toContainText('2 条消息');
  await page.getByTestId('forward-room').filter({ hasText: targetRoom }).click();
  await expect(page.getByTestId('forward-dialog')).toHaveCount(0);

  await page.goto(targetUrl);
  for (const text of ['bulk forward one', 'bulk forward two']) {
    const forwarded = page.getByTestId('message').filter({ hasText: text }).last();
    await expect(forwarded).toBeVisible();
    await expect(forwarded.locator('.forward-tag')).toContainText(`转发自 ${sourceRoom}`);
  }

  await context.close();
});

test('forwards a message with attachments', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_fwdatt_${suffix}`);
  const sourceRoom = `fwdatt-src-${suffix}`;
  await createRoom(page, sourceRoom);
  const sourceUrl = page.url();

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64',
  );
  await page.getByTestId('attach-input').setInputFiles({
    name: 'forward.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.getByTestId('attach-chip')).toHaveCount(1);
  await page.getByTestId('send').click();
  const sourceMessage = page
    .getByTestId('message')
    .filter({ has: page.getByTestId('attachment-image') })
    .last();
  await expect(sourceMessage.getByTestId('attachment-image')).toBeVisible();

  await page.goto('/rooms');
  const targetRoom = `fwdatt-dst-${suffix}`;
  await createRoom(page, targetRoom);
  const targetUrl = page.url();

  await page.goto(sourceUrl);
  const message = page
    .getByTestId('message')
    .filter({ has: page.getByTestId('attachment-image') })
    .last();
  await message.hover();
  await message.getByRole('button', { name: '转发' }).click();
  await expect(page.getByTestId('forward-dialog')).toBeVisible();
  await page.getByTestId('forward-room').filter({ hasText: targetRoom }).click();
  await expect(page.getByTestId('forward-dialog')).toHaveCount(0);

  await page.goto(targetUrl);
  const forwarded = page
    .getByTestId('message')
    .filter({ has: page.getByTestId('attachment-image') })
    .last();
  await expect(forwarded.getByTestId('attachment-image')).toHaveAttribute('src', /^blob:/);
  await expect(forwarded.locator('.forward-tag')).toContainText(`转发自 ${sourceRoom}`);

  await context.close();
});

test('forwards a poll with zeroed votes', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_fwdpoll_${suffix}`);
  const sourceRoom = `fwdpoll-src-${suffix}`;
  await createRoom(page, sourceRoom);
  const sourceUrl = page.url();
  const question = `forward-poll-${suffix}`;

  await page.getByTestId('poll-open').click();
  await page.getByTestId('poll-question').fill(question);
  await page.getByTestId('poll-option-0').fill('甲选项');
  await page.getByTestId('poll-option-1').fill('乙选项');
  await page.getByTestId('poll-submit').click();
  const sourceCard = page.getByTestId('poll-card').filter({ hasText: question });
  await sourceCard.getByTestId('poll-option').first().click();
  await sourceCard.getByTestId('poll-submit').click();
  await expect(sourceCard).toContainText('1 人参与');

  await page.goto('/rooms');
  const targetRoom = `fwdpoll-dst-${suffix}`;
  await createRoom(page, targetRoom);
  const targetUrl = page.url();

  await page.goto(sourceUrl);
  const message = page.getByTestId('message').filter({ hasText: question }).last();
  await message.hover();
  await message.getByRole('button', { name: '转发' }).click();
  await expect(page.getByTestId('forward-dialog')).toBeVisible();
  await page.getByTestId('forward-room').filter({ hasText: targetRoom }).click();
  await expect(page.getByTestId('forward-dialog')).toHaveCount(0);

  await page.goto(targetUrl);
  const forwarded = page.getByTestId('poll-card').filter({ hasText: question });
  await expect(forwarded).toBeVisible();
  await expect(forwarded).toContainText('0 人参与');
  await expect(forwarded.getByTestId('poll-option')).toHaveCount(2);
  await expect(forwarded.getByTestId('poll-option').first()).toContainText('甲选项');

  await context.close();
});

test('filters pinned messages by text', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_pinsearch_${suffix}`);
  await createRoom(page, `pinsearch-room-${suffix}`);
  await send(page, 'pinned alpha');
  await send(page, 'pinned beta');

  for (const text of ['pinned alpha', 'pinned beta']) {
    const message = page.getByTestId('message').filter({ hasText: text }).last();
    await message.hover();
    await message.getByRole('button', { name: '置顶' }).click();
  }

  await page.getByRole('button', { name: '置顶消息' }).click();
  await expect(page.locator('.pin-card')).toHaveCount(2);
  await page.getByLabel('搜索置顶消息').fill('alpha');
  await expect(page.locator('.pin-card')).toHaveCount(1);
  await expect(page.locator('.pin-card')).toContainText('pinned alpha');
  await expect(page.getByTestId('pins-match-count')).toContainText('匹配 1 / 2');
  await page.getByLabel('清空搜索').click();
  await expect(page.locator('.pin-card')).toHaveCount(2);

  await context.close();
});

test('favorites a room and pins it above newer rooms', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_fav_${suffix}`);
  const roomA = `fav-a-${suffix}`;
  await createRoom(page, roomA);
  await send(page, 'favorite me');

  await page.goto('/rooms');
  await createRoom(page, `fav-b-${suffix}`);
  await page.goto('/rooms');

  const card = page.getByTestId('room-item').filter({ hasText: roomA });
  await card.click({ button: 'right' });
  await page.getByTestId('room-menu-favorite').click();
  await expect(card.getByTestId('room-favorite')).toBeVisible();
  await expect(page.getByTestId('room-item').first()).toContainText(roomA);

  await card.click({ button: 'right' });
  await page.getByTestId('room-menu-mute').click();
  await expect(card.getByTestId('room-muted')).toBeVisible();

  await page.getByTestId('room-filter-favorite').click();
  await expect(page.getByTestId('room-item')).toHaveCount(1);
  await expect(page.getByTestId('room-item')).toContainText(roomA);

  await page.getByTestId('room-filter-unread').click();
  await expect(page.getByTestId('room-item')).toHaveCount(0);
  await expect(page.getByText('没有未读房间')).toBeVisible();

  await page.getByTestId('room-filter-all').click();
  await expect(page.getByTestId('room-item')).toHaveCount(2);

  await context.close();
});

test('groups rooms and collapses the section', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_grp_${suffix}`);
  const roomA = `grp-a-${suffix}`;
  await createRoom(page, roomA);
  await page.goto('/rooms');
  await createRoom(page, `grp-b-${suffix}`);
  await page.goto('/rooms');

  const card = page.getByTestId('room-item').filter({ hasText: roomA });
  await card.click({ button: 'right' });
  await page.getByTestId('room-menu-group').click();
  await expect(page.getByTestId('group-dialog')).toBeVisible();
  const groupName = `项目${suffix.slice(-4)}`;
  await page.getByTestId('group-input').fill(groupName);
  await page.getByTestId('group-save').click();
  await expect(page.getByTestId('group-dialog')).toBeHidden();

  const section = page.getByTestId('room-section').filter({ hasText: groupName });
  await expect(section).toBeVisible();
  await expect(card).toBeVisible();

  await section.click();
  await expect(card).toBeHidden();
  await section.click();
  await expect(card).toBeVisible();

  await context.close();
});

test('mention notification jumps to the message', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_ntf_a_${suffix}`;
  const member = `e2e_ntf_b_${suffix}`;
  const roomName = `ntf-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await send(pageA, `@${member} hello notif`);
  await expect(pageB.getByTestId('notifications-badge')).toBeVisible();
  await openNotifications(pageB);
  await expect(pageB.getByTestId('notification-panel')).toBeVisible();
  const item = pageB.getByTestId('notification-item').first();
  await expect(item).toContainText('hello notif');
  await pageB.getByTestId('notif-filter-join').click();
  await expect(pageB.getByTestId('notification-item')).toHaveCount(0);
  await expect(pageB.getByTestId('notification-empty')).toContainText('暂无加入通知');
  await pageB.getByTestId('notif-filter-mention').click();
  await expect(item).toBeVisible();
  await item.click();
  await expect(pageB.locator('.msg.highlight')).toContainText('hello notif');
  await expect(pageB.getByTestId('notifications-badge')).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test('loads older notification pages', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_ntfpage_a_${suffix}`;
  const member = `e2e_ntfpage_b_${suffix}`;
  const roomName = `ntfpage-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  const roomId = Number(pageA.url().split('/').pop());
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await pageA.evaluate(
    async ({ roomId, username, count }) => {
      const socket = window.__socket;
      if (!socket) {
        throw new Error('__socket missing');
      }
      for (let index = 0; index < count; index += 1) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        socket.emit(
          'message:send',
          {
            roomId,
            content: `@${username} page-${index}`,
            clientMsgId: `page-${index}`,
          },
          (result) => {
            if (result?.ok) {
              resolve();
            } else {
              reject(new Error('mention send failed'));
            }
          },
        );
        await promise;
      }
    },
    { roomId, username: member, count: 21 },
  );

  await expect(pageB.getByTestId('notifications-badge')).toContainText('21');
  await openNotifications(pageB);
  await expect(pageB.getByTestId('notification-item')).toHaveCount(20);
  const summaryChip = pageB.getByTestId('notif-summary').filter({ hasText: roomName });
  await expect(summaryChip).toContainText('21');
  await expect(
    pageB.getByTestId('notif-filter-mention').getByTestId('notif-filter-count'),
  ).toHaveText('21');
  await pageB.getByTestId('notification-load-more').click();
  await expect(pageB.getByTestId('notification-item')).toHaveCount(21);
  await expect(pageB.getByTestId('notification-load-more')).toHaveCount(0);
  await summaryChip.click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await contextA.close();
  await contextB.close();
});

test('syncs drafts across devices', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const user = `e2e_draft_${suffix}`;
  const roomName = `draft-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, user);
  await createRoom(pageA, roomName);
  const roomId = pageA.url().split('/').pop() ?? '';
  const roomUrl = pageA.url();

  const draft = `unsent draft ${suffix}`;
  await pageA.getByTestId('composer').fill(draft);
  const token = await pageA.evaluate(() => localStorage.getItem('bfa_token'));
  const headers = { Authorization: `Bearer ${token}` };
  await expect
    .poll(async () => {
      const response = await pageA.request.get(`/api/rooms/${roomId}/draft`, { headers });
      return response.ok() ? (await response.json()).draft?.content : null;
    })
    .toBe(draft);

  await pageB.goto('/login');
  await pageB.getByTestId('username').fill(user);
  await pageB.getByTestId('password').fill('password123');
  await pageB.getByTestId('login-submit').click();
  await pageB.waitForSelector('[data-testid=create-room]');
  await pageB.goto(roomUrl);
  await expect(pageB.getByTestId('composer')).toHaveValue(draft);

  await pageA.getByTestId('send').click();
  await expect(
    pageA.getByTestId('message').filter({ hasText: draft }).last(),
  ).toBeVisible();
  await expect
    .poll(async () => {
      const response = await pageA.request.get(`/api/rooms/${roomId}/draft`, { headers });
      return response.ok() ? (await response.json()).draft : null;
    })
    .toBeNull();

  // The other device keeps its own local copy until that user clears it; an
  // explicit clear propagates to the server and survives a reload.
  await pageB.getByTestId('composer').fill('');
  await pageB.waitForTimeout(1200);
  await pageB.reload();
  await expect(pageB.getByTestId('composer')).toHaveValue('');

  await contextA.close();
  await contextB.close();
});

test('bulk deletes selected notifications', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_ntfbulk_a_${suffix}`;
  const member = `e2e_ntfbulk_b_${suffix}`;
  const roomName = `ntfbulk-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await send(pageA, `@${member} bulk one`);
  await send(pageA, `@${member} bulk two`);
  await expect(pageB.getByTestId('notifications-badge')).toBeVisible();
  await openNotifications(pageB);
  await expect(pageB.getByTestId('notification-item')).toHaveCount(2);
  await pageB.getByTestId('notification-select-all').check();
  await pageB.getByTestId('notification-bulk-read').click();
  await expect(
    pageB.locator('.el-message').filter({ hasText: '已标记 2 条已读' }),
  ).toBeVisible();
  await expect(pageB.getByTestId('notifications-badge')).toHaveCount(0);
  await expect(pageB.getByTestId('notification-item')).toHaveCount(2);
  await pageB.getByTestId('notification-select-all').check();
  await pageB.getByTestId('notification-bulk-delete').click();
  await expect(
    pageB.locator('.el-message').filter({ hasText: '已删除 2 条通知' }),
  ).toBeVisible();
  await expect(pageB.getByTestId('notification-item')).toHaveCount(0);
  await expect(pageB.getByTestId('notifications-badge')).toHaveCount(0);

  await pageB.reload();
  await openNotifications(pageB);
  await expect(pageB.getByTestId('notification-item')).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test('deletes notifications and clears read history', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_ntfdel_a_${suffix}`;
  const member = `e2e_ntfdel_b_${suffix}`;
  const roomName = `ntfdel-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await send(pageA, `@${member} delete one`);
  await send(pageA, `@${member} delete two`);
  await expect(pageB.getByTestId('notifications-badge')).toBeVisible();
  await openNotifications(pageB);
  await expect(pageB.getByTestId('notification-item')).toHaveCount(2);

  await pageB.getByTestId('notif-search').fill('delete one');
  await expect(pageB.getByTestId('notification-item')).toHaveCount(1);
  await expect(pageB.getByTestId('notification-item')).toContainText('delete one');
  await pageB.getByTestId('notif-search').fill('');
  await expect(pageB.getByTestId('notification-item')).toHaveCount(2);

  const exportPromise = pageB.waitForEvent('download');
  await pageB.getByTestId('notifications-export').click();
  const exportDownload = await exportPromise;
  expect(exportDownload.suggestedFilename()).toBe('notifications.csv');
  const exportPath = await exportDownload.path();
  if (exportPath === null) {
    throw new Error('notifications export has no path');
  }
  const csv = await readFile(exportPath, 'utf8');
  expect(csv).toContain('id,type,roomName,actorName,content,createdAt,readAt');
  expect(csv).toContain('delete one');
  expect(csv).toContain('delete two');

  await pageB.getByTestId('notification-item').first().click({ force: true });
  await expect(pageB.getByTestId('notifications-badge')).toBeVisible();
  await openNotifications(pageB);
  await expect(pageB.getByTestId('notification-item')).toHaveCount(2);
  await pageB.getByTestId('notification-clear-read').click();
  await pageB.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    pageB.locator('.el-message').filter({ hasText: '已清空 1 条已读通知' }),
  ).toBeVisible();
  await expect(pageB.getByTestId('notification-item')).toHaveCount(1);

  await pageB.getByTestId('notification-delete').first().click();
  await expect(pageB.getByTestId('notification-item')).toHaveCount(0);
  await expect(pageB.getByTestId('notifications-badge')).toHaveCount(0);

  await pageB.reload();
  await openNotifications(pageB);
  await expect(pageB.getByTestId('notification-item')).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test('member profile shows role and join time', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_prof_a_${suffix}`;
  const member = `e2e_prof_b_${suffix}`;
  const roomName = `prof-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  const row = pageA.getByTestId('member-row').filter({ hasText: member });
  await expect(row).toBeVisible();
  await row.click();
  const profile = pageA.getByTestId('member-profile');
  await expect(profile).toBeVisible();
  await expect(profile).toContainText(`@${member}`);
  await expect(profile).toContainText('加入');
  await expect(profile).toContainText('成员');
  await pageA.getByTestId('member-profile-copy').click();
  await pageA.keyboard.press('Escape');
  await expect(profile).toBeHidden();

  await contextA.close();
  await contextB.close();
});

test('admin overview and user detail', async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/login');
  await page.getByTestId('username').fill('admin');
  await page.getByTestId('password').fill('e2e-admin-pass');
  await page.getByTestId('login-submit').click();
  await page.waitForSelector('[data-testid=create-room]');

  await page.goto('/admin');
  await page.waitForSelector('[data-testid=admin-stats]');
  await expect(page.getByTestId('admin-stats')).toContainText('用户');
  await expect(page.getByTestId('admin-stats')).toContainText('消息');

  const statsDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('admin-trend-days').selectOption('7');
  await expect(page.getByTestId('admin-trend')).toContainText('最近 7 天');
  await expect(page.getByTestId('admin-compare')).toBeVisible();
  await expect(page.getByTestId('admin-compare-users')).toContainText('本期');
  await page.getByTestId('admin-stats-export').click();
  const statsDownload = await statsDownloadPromise;
  expect(statsDownload.suggestedFilename()).toBe('admin-trend-7d.csv');
  const statsPath = await statsDownload.path();
  if (statsPath === null) {
    throw new Error('stats export has no path');
  }
  expect(await readFile(statsPath, 'utf8')).toContain(
    'date,users,messages,rooms,bots',
  );

  await page.getByTestId('admin-users-tab').click();
  await expect(page.getByTestId('admin-user-row').first()).toBeVisible();
  const usersDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('admin-users-export').click();
  const usersDownload = await usersDownloadPromise;
  expect(usersDownload.suggestedFilename()).toBe('users.csv');
  const usersPath = await usersDownload.path();
  if (usersPath === null) {
    throw new Error('users export has no path');
  }
  expect(await readFile(usersPath, 'utf8')).toContain(
    'id,username,displayName,type,role,status,statusEmoji,statusText,createdAt',
  );
  await page.getByTestId('admin-user-row').first().click();
  const detail = page.getByTestId('admin-user-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('加入房间');
  await page.getByTestId('admin-user-detail-close').click();
  await expect(detail).toBeHidden();

  await page.getByTestId('admin-audit-tab').click();
  const localToday = await page.evaluate(() => {
    const date = new Date();
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(
      date.getDate(),
    ).padStart(2, '0')}`;
  });
  await page.getByTestId('audit-range-today').click();
  await expect(page.getByTestId('audit-from')).toHaveValue(localToday);
  await expect(page.getByTestId('audit-to')).toHaveValue(localToday);
  await page.getByTestId('audit-range-7').click();
  await expect(page.getByTestId('audit-to')).toHaveValue(localToday);
  await expect(page.getByTestId('audit-from')).not.toHaveValue(localToday);
  await page.getByTestId('audit-range-clear').click();
  await expect(page.getByTestId('audit-from')).toHaveValue('');
  await expect(page.getByTestId('audit-to')).toHaveValue('');

  const today = new Date().toISOString().slice(0, 10);
  await page.getByTestId('admin-audit-actor').fill('admin');
  await page.getByTestId('admin-audit-actor').press('Enter');
  await page.getByTestId('audit-from').fill(today);
  await page.getByTestId('audit-to').fill(today);
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('audit-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('audit-export.csv');
  const path = await download.path();
  if (path === null) {
    throw new Error('audit export has no path');
  }
  const csv = await readFile(path, 'utf8');
  expect(csv).toContain('id,createdAt,actorName,action,targetType,targetId,detail');

  const allDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('audit-export-all').click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  const allDownload = await allDownloadPromise;
  expect(allDownload.suggestedFilename()).toBe('audit-export-all.csv');
  const allPath = await allDownload.path();
  if (allPath === null) {
    throw new Error('audit full export has no path');
  }
  expect(await readFile(allPath, 'utf8')).toContain(
    'id,createdAt,actorName,action,targetType,targetId,detail',
  );

  await context.close();
});

test('bulk bans and unbans users from the admin table', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const target = `e2e_bulk_${suffix}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  const registered = await page.request.post('/api/auth/register', {
    data: {
      username: target,
      password: PASSWORD,
      displayName: target,
    },
  });
  expect(registered.ok()).toBe(true);

  await page.goto('/login');
  await page.getByTestId('username').fill('admin');
  await page.getByTestId('password').fill('e2e-admin-pass');
  await page.getByTestId('login-submit').click();
  await page.waitForSelector('[data-testid=create-room]');

  await page.goto('/admin');
  await page.getByTestId('admin-users-tab').click();
  await page.getByTestId('admin-search').fill(target);
  await page.getByTestId('admin-search').press('Enter');

  const row = page.getByTestId('admin-user-row').filter({ hasText: target });
  await expect(row).toBeVisible();
  await row.getByTestId('admin-user-check').check();
  await expect(page.getByTestId('admin-bulk-ban')).toBeEnabled();
  await page.getByTestId('admin-bulk-ban').click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(row.getByTestId('admin-user-status')).toContainText('已封禁');

  await row.getByTestId('admin-user-check').check();
  await page.getByTestId('admin-bulk-unban').click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(row.getByTestId('admin-user-status')).toContainText('正常');

  await context.close();
});

test('bulk deletes rooms from the admin table', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const roomName = `e2e_admin_room_${suffix}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('/login');
  await page.getByTestId('username').fill('admin');
  await page.getByTestId('password').fill('e2e-admin-pass');
  await page.getByTestId('login-submit').click();
  await page.waitForSelector('[data-testid=create-room]');

  const token = await page.evaluate(() => localStorage.getItem('bfa_token'));
  const created = await page.request.post('/api/rooms', {
    headers: { Authorization: `Bearer ${token}` },
    data: { name: roomName, isPublic: false },
  });
  expect(created.ok()).toBe(true);

  await page.goto('/admin');
  await page.getByTestId('admin-rooms-tab').click();
  await page.getByTestId('admin-room-search').fill(roomName);
  await page.getByTestId('admin-room-search').press('Enter');

  const row = page.getByTestId('admin-room-row').filter({ hasText: roomName });
  await expect(row).toBeVisible();
  const roomsDownloadPromise = page.waitForEvent('download');
  await page.getByTestId('admin-rooms-export').click();
  const roomsDownload = await roomsDownloadPromise;
  expect(roomsDownload.suggestedFilename()).toBe('rooms.csv');
  const roomsPath = await roomsDownload.path();
  if (roomsPath === null) {
    throw new Error('rooms export has no path');
  }
  expect(await readFile(roomsPath, 'utf8')).toContain(
    'id,name,ownerId,ownerName,isPublic,memberCount,messageCount,retentionDays,createdAt',
  );
  await row.click();
  const detail = page.getByTestId('admin-room-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText(roomName);
  await expect(detail).toContainText('admin');
  await page.getByTestId('admin-room-detail-close').click();
  await expect(detail).toBeHidden();
  await row.getByTestId('admin-room-check').check();
  await page.getByTestId('admin-room-bulk-delete').click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    page.locator('.el-message').filter({ hasText: '已删除 1 个房间' }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);

  await context.close();
});

test('renders a link preview for urls', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_preview_${suffix}`);
  await createRoom(page, `preview-room-${suffix}`);
  await send(page, '看这个 http://127.0.0.1:4010/preview');

  const preview = page.getByTestId('link-preview');
  await expect(preview).toBeVisible({ timeout: 15_000 });
  await expect(preview).toContainText('Fake & Preview');
  await expect(preview).toContainText('Fake Provider');

  await context.close();
});

test('transfers room ownership', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_own2_a_${suffix}`;
  const member = `e2e_own2_b_${suffix}`;
  const roomName = `transfer-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await pageA.getByTitle('房间设置').click();
  const settings = pageA.locator('.el-dialog').filter({ hasText: '转让房主' });
  await settings.getByTestId('transfer-select').selectOption({ label: member });
  await settings.getByTestId('transfer-submit').click();
  await pageA.locator('.el-message-box__btns .el-button--primary').click();

  const memberRow = pageA.getByTestId('member-row').filter({ hasText: member });
  await expect(memberRow.locator('.role-tag')).toHaveText('房主');

  await pageB.getByTitle('房间设置').click();
  await expect(pageB.locator('.el-dialog input').first()).toBeEnabled();
  await pageB.keyboard.press('Escape');

  await contextA.close();
  await contextB.close();
});

test('changes the account password and logs in with it', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const username = `e2e_pwd_${suffix}`;
  const newPassword = 'NewPass_12345';
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, username);
  await page.locator('.sidebar-user').click();
  await expect(page.getByRole('button', { name: '修改密码' })).toBeVisible();
  await page.locator('input[autocomplete="current-password"]').fill('password123');
  await page.locator('input[autocomplete="new-password"]').nth(0).fill(newPassword);
  await page.locator('input[autocomplete="new-password"]').nth(1).fill(newPassword);
  await page.getByRole('button', { name: '修改密码' }).click();
  await expect(page.locator('.el-message').filter({ hasText: '密码已修改' })).toBeVisible();

  await page.getByRole('button', { name: '退出登录' }).click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await page.waitForURL('**/login');

  await page.getByTestId('username').fill(username);
  await page.getByTestId('password').fill(newPassword);
  await page.getByTestId('login-submit').click();
  await page.waitForSelector('[data-testid=create-room]');

  await context.close();
});

test('requests and approves joining a private room', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_req_a_${suffix}`;
  const member = `e2e_req_b_${suffix}`;
  const roomName = `private-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await pageA.getByTestId('create-room').click();
  await pageA.getByTestId('room-name').fill(roomName);
  await pageA
    .locator('.el-dialog')
    .filter({ hasText: '创建房间' })
    .locator('input[type=checkbox]')
    .uncheck();
  await pageA.getByTestId('create-room-submit').click();
  await pageA.waitForURL(/\/rooms\/\d+$/);
  const roomUrl = pageA.url();
  const roomId = roomUrl.split('/').pop() ?? '';

  await register(pageB, member);
  await pageB.locator('.sidebar-actions').getByRole('button', { name: '加入' }).click();
  await pageB.getByLabel('房间 ID').fill(roomId);
  await pageB.getByTestId('join-request-submit').click();
  await expect(pageB.locator('.el-message').filter({ hasText: '已提交申请' })).toBeVisible();

  await expect(pageA.getByTestId('notifications-badge')).toBeVisible();
  await pageA.getByTitle('房间设置').click();
  const requests = pageA.getByTestId('join-requests');
  await expect(requests).toBeVisible();
  const row = requests.getByTestId('join-request-row').filter({ hasText: member });
  await expect(row).toBeVisible();
  await row.getByTestId('join-approve').click();
  await expect(row).toHaveCount(0);

  await pageB.goto(roomUrl);
  await expect(pageB.getByTestId('composer')).toBeEnabled();

  await contextA.close();
  await contextB.close();
});

test('bulk approves join requests', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_reqbulk_a_${suffix}`;
  const applicants = [`e2e_reqbulk_b_${suffix}`, `e2e_reqbulk_c_${suffix}`];
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, owner);
  const ownerToken = await page.evaluate(() => localStorage.getItem('bfa_token'));
  const ownerHeaders = { Authorization: `Bearer ${ownerToken}` };
  const created = await page.request.post('/api/rooms', {
    headers: ownerHeaders,
    data: { name: `reqbulk-room-${suffix}`, isPublic: false },
  });
  expect(created.ok()).toBe(true);
  const roomId = (await created.json()).room.id as number;
  await page.goto(`/rooms/${roomId}`);

  for (const username of applicants) {
    const registered = await page.request.post('/api/auth/register', {
      data: { username, password: PASSWORD, displayName: username },
    });
    expect(registered.ok()).toBe(true);
    const token = (await registered.json()).token as string;
    const requested = await page.request.post(`/api/rooms/${roomId}/request`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(requested.ok()).toBe(true);
  }

  await page.getByTitle('房间设置').click();
  const requests = page.getByTestId('join-requests');
  await expect(requests.getByTestId('join-request-row')).toHaveCount(2);
  await requests.getByTestId('join-select-all').check();
  await requests.getByTestId('join-bulk-approve').click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    page.locator('.el-message').filter({ hasText: '已批准 2 条申请' }),
  ).toBeVisible();
  await expect(requests.getByTestId('join-request-row')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('member-row').filter({ hasText: applicants[0] })).toBeVisible();

  await context.close();
});

test('shows read receipts for own messages', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_read_a_${suffix}`;
  const member = `e2e_read_b_${suffix}`;
  const roomName = `read-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await send(pageA, 'read receipt target');
  await expect(pageB.getByTestId('message').filter({ hasText: 'read receipt target' })).toHaveCount(1);

  const receipt = pageA.getByTestId('read-receipt');
  await expect(receipt).toBeVisible({ timeout: 15_000 });
  await expect(receipt).toContainText('已读 1');

  await contextA.close();
  await contextB.close();
});

test('rotates a private room invite code', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_rot_a_${suffix}`;
  const member = `e2e_rot_b_${suffix}`;
  const roomName = `rotate-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await pageA.getByTestId('create-room').click();
  await pageA.getByTestId('room-name').fill(roomName);
  await pageA
    .locator('.el-dialog')
    .filter({ hasText: '创建房间' })
    .locator('input[type=checkbox]')
    .uncheck();
  await pageA.getByTestId('create-room-submit').click();
  await pageA.waitForURL(/\/rooms\/\d+$/);
  const roomId = pageA.url().split('/').pop() ?? '';

  await pageA.getByTitle('房间设置').click();
  await expect(pageA.getByTestId('rotate-invite')).toBeVisible();
  const qr = pageA.getByTestId('invite-qr');
  await expect(qr).toBeVisible();
  const oldQr = await qr.getAttribute('src');
  expect(oldQr).toMatch(/^data:image\/png;base64,/);
  const codeLocator = pageA.locator('.invite-row code');
  const oldCode = (await codeLocator.textContent())?.trim() ?? '';
  expect(oldCode).toMatch(/^[0-9a-f]{8}$/);

  const qrDownloadPromise = pageA.waitForEvent('download');
  await pageA.getByTestId('invite-qr-download').click();
  const qrDownload = await qrDownloadPromise;
  expect(qrDownload.suggestedFilename()).toBe(`room-${roomId}-invite.png`);
  const qrPath = await qrDownload.path();
  if (qrPath === null) {
    throw new Error('QR download has no path');
  }
  const qrBytes = await readFile(qrPath);
  expect(qrBytes.subarray(0, 4).toString('hex')).toBe('89504e47');

  await pageA.getByTestId('rotate-invite').click();
  await pageA.locator('.el-message-box__btns .el-button--primary').click();
  await expect.poll(async () => (await codeLocator.textContent())?.trim()).not.toBe(oldCode);
  const newCode = (await codeLocator.textContent())?.trim() ?? '';
  expect(newCode).toMatch(/^[0-9a-f]{8}$/);
  await expect.poll(async () => qr.getAttribute('src')).not.toBe(oldQr);

  await register(pageB, member);
  const token = await pageB.evaluate(() => localStorage.getItem('bfa_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const oldJoin = await pageB.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: { inviteCode: oldCode },
  });
  expect(oldJoin.status()).toBe(403);
  const newJoin = await pageB.request.post(`/api/rooms/${roomId}/join`, {
    headers,
    data: { inviteCode: newCode },
  });
  expect(newJoin.status()).toBe(200);

  await contextA.close();
  await contextB.close();
});

test('windows large message lists', async ({ browser }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_win_${suffix}`);
  await createRoom(page, `win-room-${suffix}`);
  const roomId = Number(page.url().split('/').pop());

  await page.evaluate(
    async ({ roomId, count }) => {
      const socket = window.__socket;
      if (!socket) {
        throw new Error('__socket missing');
      }
      for (let index = 0; index < count; index += 1) {
        const clientMsgId = `bulk-${index}`;
        let lastError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const { promise, resolve, reject } = Promise.withResolvers<void>();
          const timer = window.setTimeout(
            () => reject(new Error('send ack timeout')),
            3000,
          );
          socket.emit(
            'message:send',
            { roomId, content: `bulk-${index}`, clientMsgId },
            (res) => {
              window.clearTimeout(timer);
              if (res?.ok) {
                resolve();
              } else {
                reject(new Error('send failed'));
              }
            },
          );
          try {
            await promise;
            lastError = null;
            break;
          } catch (error) {
            lastError = error;
          }
        }
        if (lastError) {
          throw lastError;
        }
      }
    },
    { roomId, count: 210 },
  );

  const last = page.getByTestId('message').filter({ hasText: 'bulk-209' });
  await expect(last).toBeVisible({ timeout: 30_000 });
  expect(await page.locator('[data-testid=message]').count()).toBeLessThanOrEqual(200);
  await expect(page.locator('.message-list--dense')).toHaveCount(1);

  const reveal = page.getByTestId('reveal-earlier');
  await expect(reveal).toBeVisible();
  // The button sits at the top of the scroll container, where the sticky
  // room header can intercept a pointer click after Playwright scrolls it
  // into view. This test exercises windowing, not hit-testing.
  await reveal.evaluate((node) => (node as HTMLButtonElement).click());
  await expect(page.locator('[data-testid=message]')).toHaveCount(210);
  await expect(page.getByTestId('message').filter({ hasText: 'bulk-0' })).toBeVisible();

  await context.close();
});

test('stops a streaming bot reply', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_stop_${suffix}`);
  await createRoom(page, `stop-room-${suffix}`);
  const roomId = Number(page.url().split('/').pop());
  const token = await page.evaluate(() => localStorage.getItem('bfa_token'));

  const created = await page.request.post('/api/me/bots', {
    headers: { Authorization: `Bearer ${token}` },
    data: {
      name: 'slow-bot',
      roomId,
      baseUrl: 'http://127.0.0.1:4010',
      apiKey: 'test-key',
      model: 'fake-slow',
      triggerMode: 'mention',
    },
  });
  expect(created.ok()).toBeTruthy();
  const payload: unknown = await created.json();
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

  await send(page, `@${botUsername} 请慢速回复`);
  await expect(page.locator('.cursor')).toBeVisible({ timeout: 10_000 });
  await page.getByTestId('stop-bots').click();
  await expect(page.getByTestId('stop-bots')).toHaveCount(0);
  await expect(page.locator('.msg-error')).toContainText('生成失败');

  await page.waitForTimeout(3500);
  await expect(page.getByTestId('message').filter({ hasText: '慢回复' })).toHaveCount(0);

  await context.close();
});

test('updates custom status shown to room members', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_status_a_${suffix}`;
  const member = `e2e_status_b_${suffix}`;
  const roomName = `status-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  await pageA.locator('.sidebar-user').click();
  await pageA.getByLabel('Emoji').fill('🎧');
  await pageA.getByLabel('状态文本').fill('专注写代码');
  await pageA.getByRole('button', { name: '保存' }).click();
  await expect(pageA.locator('.el-message').filter({ hasText: '已保存' })).toBeVisible();

  const ownerRow = pageB.getByTestId('member-row').filter({ hasText: owner });
  await expect(ownerRow).toContainText('🎧');
  await expect(ownerRow).toContainText('专注写代码');

  await ownerRow.click();
  const profile = pageB.getByTestId('member-profile');
  await expect(profile).toContainText('🎧');
  await expect(profile).toContainText('专注写代码');
  await pageB.keyboard.press('Escape');

  await contextA.close();
  await contextB.close();
});

test('enforces room slow mode', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_slow_${suffix}`);
  await createRoom(page, `slow-room-${suffix}`);

  await page.getByTitle('房间设置').click();
  const settings = page.locator('.el-dialog').filter({ hasText: '慢速模式' });
  await page.getByTestId('slow-mode-select').selectOption('5');
  await settings.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('slow-mode-badge')).toContainText('5');

  await send(page, 'slow first');
  await expect(page.getByTestId('message').filter({ hasText: 'slow first' })).toHaveCount(1);
  await send(page, 'slow second');
  await expect(page.locator('.el-message--error').filter({ hasText: '慢速模式' })).toBeVisible();

  await context.close();
});

test('invites a member by username and copies a message link', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_inv_a_${suffix}`;
  const member = `e2e_inv_b_${suffix}`;
  const roomName = `invite-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);

  await pageA.getByTitle('房间设置').click();
  await pageA.getByTestId('invite-username').fill(member);
  await pageA.getByTestId('invite-submit').click();
  await expect(pageA.locator('.el-message').filter({ hasText: `已邀请 @${member}` })).toBeVisible();
  await pageA.keyboard.press('Escape');
  await expect(pageA.locator('.el-dialog').filter({ hasText: '房间设置' })).toBeHidden();

  await expect(pageB.getByTestId('notifications-badge')).toBeVisible();
  await openNotifications(pageB);
  const notification = pageB.getByTestId('notification-item').first();
  await expect(notification).toContainText('邀请你加入房间');
  await notification.click();
  await pageB.waitForURL(/\/rooms\/\d+$/);
  await expect(pageB.getByTestId('composer')).toBeEnabled();

  await send(pageA, 'link target');
  const message = pageA
    .getByTestId('message')
    .filter({ hasText: 'link target' })
    .last();
  await message.click({ button: 'right' });
  await expect(pageA.getByTestId('copy-link')).toBeVisible();
  await pageA.keyboard.press('Escape');

  await contextA.close();
  await contextB.close();
});

test('invites multiple members at once', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_binvite_a_${suffix}`;
  const first = `e2e_binvite_b_${suffix}`;
  const second = `e2e_binvite_c_${suffix}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, owner);
  await createRoom(page, `binvite-room-${suffix}`);
  for (const username of [first, second]) {
    const created = await page.request.post('/api/auth/register', {
      data: { username, password: PASSWORD, displayName: username },
    });
    expect(created.ok()).toBe(true);
  }

  await page.getByTitle('房间设置').click();
  await page.getByTestId('invite-username').fill(`${first}, ${second}`);
  await page.getByTestId('invite-submit').click();
  await expect(
    page.locator('.el-message').filter({ hasText: '已邀请 2 名成员' }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('member-row').filter({ hasText: first })).toBeVisible();
  await expect(page.getByTestId('member-row').filter({ hasText: second })).toBeVisible();
  await page.getByTestId('member-filter').fill(first);
  await expect(page.getByTestId('member-row').filter({ hasText: first })).toBeVisible();
  await expect(page.getByTestId('member-row').filter({ hasText: second })).toHaveCount(0);
  await page.getByTestId('member-filter').fill('');
  await expect(page.getByTestId('member-row').filter({ hasText: second })).toBeVisible();

  await context.close();
});

test('bulk deletes selected messages', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_bulk_${suffix}`);
  await createRoom(page, `bulk-room-${suffix}`);
  await send(page, 'bulk one');
  await send(page, 'bulk two');
  await send(page, 'bulk three');

  await page.getByTestId('select-mode').click();
  await expect(page.getByTestId('select-toolbar')).toBeVisible();
  const checkboxes = page.getByTestId('message-select');
  await expect(checkboxes).toHaveCount(3);
  await checkboxes.nth(0).check();
  await checkboxes.nth(1).check();
  await expect(page.getByTestId('selected-count')).toContainText('2');

  await page.getByTestId('bulk-delete').click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(page.locator('.msg.deleted')).toHaveCount(2);
  await expect(page.getByTestId('select-toolbar')).toHaveCount(0);
  await expect(page.getByTestId('message').filter({ hasText: 'bulk three' })).toBeVisible();

  await context.close();
});

test('shows edit history for edited messages', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_edit_${suffix}`);
  await createRoom(page, `edit-room-${suffix}`);
  await send(page, 'edit v1');

  for (const next of ['edit v2', 'edit v3']) {
    const message = page
      .getByTestId('message')
      .filter({ hasText: next === 'edit v2' ? 'edit v1' : 'edit v2' })
      .last();
    await message.hover();
    await message.getByRole('button', { name: '编辑', exact: true }).click();
    await page.getByTestId('composer').fill(next);
    await page.getByTestId('send').click();
    await expect(page.getByTestId('message').filter({ hasText: next })).toHaveCount(1);
  }

  await page.evaluate(() => {
    const marker = document.querySelector('[data-testid=edited-marker]');
    if (marker instanceof HTMLElement) {
      marker.click();
    }
  });
  const history = page.getByTestId('edit-history');
  await expect(history).toBeVisible();
  await expect(history.getByTestId('edit-history-item')).toHaveCount(2);
  await expect(history).toContainText('edit v1');
  await expect(history).toContainText('edit v2');
  await expect(history).toContainText('edit v3');
  await page.keyboard.press('Escape');
  await expect(history).toBeHidden();

  await context.close();
});

test('syncs notification scope across reloads', async ({ browser }) => {
  test.setTimeout(90_000);
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_settings_${suffix}`);
  await page.evaluate(() => localStorage.setItem('bfa_notify', '1'));
  await page.reload();
  await page.waitForSelector('.sidebar-user');
  await page.waitForTimeout(500);
  await page.locator('.sidebar-user').click();
  await page.getByRole('radio', { name: '仅提及' }).click();

  const token = await page.evaluate(() => localStorage.getItem('bfa_token'));
  const headers = { Authorization: `Bearer ${token}` };
  await expect
    .poll(async () => {
      const saved = await page.request.get('/api/me/settings', { headers });
      if (!saved.ok()) {
        return `status-${saved.status()}`;
      }
      const body: unknown = await saved.json();
      return typeof body === 'object' &&
        body !== null &&
        'notifyMode' in body &&
        typeof body.notifyMode === 'string'
        ? body.notifyMode
        : 'invalid';
    })
    .toBe('mention');
  await expect(page.getByRole('radio', { name: '仅提及' })).toHaveAttribute(
    'aria-checked',
    'true',
    { timeout: 15_000 },
  );

  await page.evaluate(() => localStorage.removeItem('bfa_notify_mode'));
  await page.reload();
  await page.waitForSelector('.sidebar-user');
  await page.waitForTimeout(500);
  await page.locator('.sidebar-user').click();
  await expect(page.getByRole('radio', { name: '仅提及' })).toHaveAttribute(
    'aria-checked',
    'true',
    { timeout: 15_000 },
  );
  await page.keyboard.press('Escape');

  await context.close();
});

test('searches public rooms on the server', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const roomName = `public-search-${suffix}`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, `e2e_pub_a_${suffix}`);
  await createRoom(pageA, roomName);

  await register(pageB, `e2e_pub_b_${suffix}`);
  await pageB.goto('/rooms');
  await pageB.getByTestId('tab-public').click();
  await pageB.getByLabel('搜索房间').fill(roomName);
  await expect(pageB.getByTestId('room-item').filter({ hasText: roomName })).toHaveCount(1);
  await expect(pageB.getByText('共 1 个公开房间')).toBeVisible();

  await pageB.getByLabel('搜索房间').fill('');
  await expect(pageB.getByText('共 1 个公开房间')).toHaveCount(0);
  await expect(pageB.getByTestId('room-item').first()).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test('promotes a user to admin', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const member = `e2e_promote_${suffix}`;
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const userPage = await userContext.newPage();

  await adminPage.goto('/login');
  await adminPage.getByTestId('username').fill('admin');
  await adminPage.getByTestId('password').fill('e2e-admin-pass');
  await adminPage.getByTestId('login-submit').click();
  await adminPage.waitForSelector('[data-testid=create-room]');

  await register(userPage, member);
  await adminPage.goto('/admin');
  await adminPage.getByTestId('admin-users-tab').click();
  await adminPage.getByTestId('admin-search').fill(member);
  const row = adminPage.getByTestId('admin-user-row').filter({ hasText: member });
  await expect(row).toBeVisible();
  await row.click();
  const detail = adminPage.getByTestId('admin-user-detail');
  await expect(detail).toBeVisible();
  await expect(detail).toContainText('普通用户');
  await detail.getByTestId('admin-user-role').click();
  await adminPage.locator('.el-message-box__btns .el-button--primary').click();
  await expect(adminPage.locator('.el-message').filter({ hasText: '已设为管理员' })).toBeVisible();

  await userPage.reload();
  await userPage.goto('/admin');
  await expect(userPage.getByTestId('admin-stats')).toBeVisible();

  await adminContext.close();
  await userContext.close();
});

test('bulk assigns and removes room administrator roles', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_bulkrole_a_${suffix}`;
  const member = `e2e_bulkrole_b_${suffix}`;
  const roomName = `bulkrole-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  const row = pageA.getByTestId('member-row').filter({ hasText: member });
  await expect(row).toBeVisible();
  await row.getByTestId('member-select').check();
  await pageA.getByTestId('member-bulk-admin').click();
  await pageA.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    pageA.locator('.el-message').filter({ hasText: '已更新 1 名成员角色' }),
  ).toBeVisible();
  await expect(row.locator('.role-tag')).toContainText('管理员');

  await row.getByTestId('member-select').check();
  await pageA.getByTestId('member-bulk-member').click();
  await pageA.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    pageA.locator('.el-message').filter({ hasText: '已更新 1 名成员角色' }),
  ).toBeVisible();
  await expect(row.locator('.role-tag')).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test('bulk removes members from a room', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_bulkremove_a_${suffix}`;
  const member = `e2e_bulkremove_b_${suffix}`;
  const roomName = `bulkremove-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);

  const row = pageA.getByTestId('member-row').filter({ hasText: member });
  await expect(row).toBeVisible();
  await row.getByTestId('member-select').check();
  await pageA.getByTestId('member-bulk-remove').click();
  await pageA.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    pageA.locator('.el-message').filter({ hasText: '已移出 1 名成员' }),
  ).toBeVisible();
  await expect(row).toHaveCount(0);
  await pageB.waitForURL('**/rooms');

  await contextA.close();
  await contextB.close();
});

test('shows last seen for an offline member', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_seen_a_${suffix}`;
  const member = `e2e_seen_b_${suffix}`;
  const roomName = `seen-room-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, roomName);
  await register(pageB, member);
  await pageB.getByTestId('tab-public').click();
  await pageB.getByTestId('room-item').filter({ hasText: roomName }).click();
  await pageB.waitForURL(/\/rooms\/\d+$/);
  const roomUrl = pageB.url();

  await contextB.close();
  await pageA.waitForTimeout(700);
  await pageA.goto(roomUrl);
  const row = pageA.getByTestId('member-row').filter({ hasText: member });
  await expect(row).toBeVisible();
  await row.click();
  const profile = pageA.getByTestId('member-profile');
  await expect(profile).toBeVisible();
  await expect(profile).toContainText('最后在线');

  await contextA.close();
});

test('revokes tokens on logout-all', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_revoke_${suffix}`);
  const oldToken = await page.evaluate(() => localStorage.getItem('bfa_token'));
  const revoked = await page.request.post('/api/auth/logout-all', {
    headers: { Authorization: `Bearer ${oldToken}` },
  });
  expect(revoked.ok()).toBeTruthy();
  const response: unknown = await revoked.json();
  const newToken =
    typeof response === 'object' &&
    response !== null &&
    'token' in response &&
    typeof response.token === 'string'
      ? response.token
      : '';
  expect(newToken).not.toBe('');
  expect(newToken).not.toBe(oldToken);

  const oldMe = await page.request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${oldToken}` },
  });
  expect(oldMe.status()).toBe(401);
  const newMe = await page.request.get('/api/auth/me', {
    headers: { Authorization: `Bearer ${newToken}` },
  });
  expect(newMe.status()).toBe(200);

  await context.close();
});

test('filters global search by room and opens the hit', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_sf_${suffix}`);
  const roomA = `search-filter-a-${suffix}`;
  await createRoom(page, roomA);
  await send(page, 'filter alpha');

  await page.goto('/rooms');
  const roomB = `search-filter-b-${suffix}`;
  await createRoom(page, roomB);
  await send(page, 'filter beta');

  await page.goto('/search');
  await page.getByLabel('搜索关键词').fill('filter');
  await expect(page.locator('.result')).toHaveCount(2);
  await page.getByLabel('按房间筛选').selectOption({ label: roomA });
  await expect(page.locator('.result')).toHaveCount(1);
  await expect(page.locator('.result')).toContainText('filter alpha');
  await page.locator('.result').click();
  await expect(page.locator('.msg.highlight')).toContainText('filter alpha');

  await context.close();
});

test('exports room history as markdown', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_export_${suffix}`);
  const roomName = `export-room-${suffix}`;
  await createRoom(page, roomName);
  const roomId = page.url().split('/').pop() ?? '';
  await send(page, 'export this message');
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64',
  );
  await page.getByTestId('attach-input').setInputFiles({
    name: 'export.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await expect(page.getByTestId('attach-chip')).toHaveCount(1);
  await page.getByTestId('send').click();

  await page.getByTitle('房间设置').click();
  await expect(page.getByTestId('export-md')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('export-md').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`room-${roomId}.md`);
  const path = await download.path();
  if (path === null) {
    throw new Error('download has no path');
  }
  const content = await readFile(path, 'utf8');
  expect(content).toContain(roomName);
  expect(content).toContain('export this message');

  const zipPromise = page.waitForEvent('download');
  await page.getByTestId('export-zip').click();
  const zip = await zipPromise;
  expect(zip.suggestedFilename()).toBe(`room-${roomId}.zip`);
  const zipPath = await zip.path();
  if (zipPath === null) {
    throw new Error('zip has no path');
  }
  expect((await readFile(zipPath)).subarray(0, 2).toString()).toBe('PK');

  await context.close();
});

test('publishes a platform announcement and dismisses it', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const body = `维护公告 ${suffix}`;
  const adminContext = await browser.newContext();
  const userContext = await browser.newContext();
  const adminPage = await adminContext.newPage();
  const userPage = await userContext.newPage();

  await adminPage.goto('/login');
  await adminPage.getByTestId('username').fill('admin');
  await adminPage.getByTestId('password').fill('e2e-admin-pass');
  await adminPage.getByTestId('login-submit').click();
  await adminPage.waitForSelector('[data-testid=create-room]');
  await adminPage.goto('/admin');
  await adminPage.getByTestId('announcement-body').fill(body);
  await adminPage.getByTestId('announcement-publish').click();
  await adminPage.locator('.el-message-box__btns .el-button--primary').click();
  const row = adminPage.getByTestId('announcement-row').filter({ hasText: body });
  await expect(row).toBeVisible();

  const editedBody = `${body} 已更新`;
  await row.getByTestId('announcement-edit').click();
  await adminPage.locator('.announcement-edit-box textarea').fill(editedBody);
  await adminPage.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    adminPage.locator('.el-message').filter({ hasText: '已更新公告' }),
  ).toBeVisible();
  const editedRow = adminPage
    .getByTestId('announcement-row')
    .filter({ hasText: editedBody });
  await expect(editedRow).toBeVisible();

  await register(userPage, `e2e_ann_${suffix}`);
  const banner = userPage.getByTestId('announcement-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText(editedBody);
  await userPage.getByTestId('announcement-close').click();
  await expect(banner).toHaveCount(0);
  await userPage.reload();
  await userPage.waitForSelector('[data-testid=create-room]');
  await expect(userPage.getByTestId('announcement-banner')).toHaveCount(0);

  await adminPage.reload();
  const activeRow = adminPage
    .getByTestId('announcement-row')
    .filter({ hasText: editedBody });
  await activeRow.getByTestId('announcement-deactivate').click();
  await adminPage.locator('.el-message-box__btns .el-button--primary').click();
  await expect(activeRow).toContainText('已停用');

  await adminContext.close();
  await userContext.close();
});

test('reports a message and resolves it in admin', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_rep_a_${suffix}`;
  const reporter = `e2e_rep_b_${suffix}`;
  const roomName = `report-room-${suffix}`;
  const reason = `spam message ${suffix}`;

  const ownerContext = await browser.newContext();
  const reporterContext = await browser.newContext();
  const adminContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const reporterPage = await reporterContext.newPage();
  const adminPage = await adminContext.newPage();

  await register(ownerPage, owner);
  await createRoom(ownerPage, roomName);
  await send(ownerPage, 'report target');
  await register(reporterPage, reporter);
  await reporterPage.getByTestId('tab-public').click();
  await reporterPage.getByTestId('room-item').filter({ hasText: roomName }).click();
  await reporterPage.waitForURL(/\/rooms\/\d+$/);

  await reporterPage
    .getByTestId('message')
    .filter({ hasText: 'report target' })
    .last()
    .click({ button: 'right' });
  await reporterPage.getByTestId('report').click();
  await reporterPage.getByTestId('report-reason').fill(reason);
  await reporterPage.getByTestId('report-submit').click();
  await expect(reporterPage.locator('.el-message').filter({ hasText: '举报已提交' })).toBeVisible();

  await adminPage.goto('/login');
  await adminPage.getByTestId('username').fill('admin');
  await adminPage.getByTestId('password').fill('e2e-admin-pass');
  await adminPage.getByTestId('login-submit').click();
  await adminPage.waitForSelector('[data-testid=create-room]');
  await adminPage.goto('/admin');
  await adminPage.getByTestId('admin-reports-tab').click();
  const reportRow = adminPage.getByTestId('admin-report-row').filter({ hasText: reason });
  await expect(reportRow).toBeVisible();
  const reportDownloadPromise = adminPage.waitForEvent('download');
  await adminPage.getByTestId('reports-export').click();
  const reportDownload = await reportDownloadPromise;
  expect(reportDownload.suggestedFilename()).toBe('reports-open.csv');
  const reportPath = await reportDownload.path();
  if (reportPath === null) {
    throw new Error('report export has no path');
  }
  expect(await readFile(reportPath, 'utf8')).toContain(
    'id,createdAt,roomName,senderName,messageContent,reporterName,reason,status,resolvedBy,resolvedAt',
  );
  await reportRow.getByTestId('admin-report-check').check();
  await adminPage.getByTestId('admin-report-bulk-resolve').click();
  await adminPage.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    adminPage.locator('.el-message').filter({ hasText: '已处理 1 条举报' }),
  ).toBeVisible();
  await expect(reportRow).toHaveCount(0);

  await ownerContext.close();
  await reporterContext.close();
  await adminContext.close();
});

test('delivers a scheduled message', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_sched_${suffix}`);
  await createRoom(page, `sched-room-${suffix}`);
  const roomId = Number(page.url().split('/').pop());
  const token = await page.evaluate(() => localStorage.getItem('bfa_token'));
  const sendAt = new Date(Date.now() + 3000).toISOString();
  const queued = await page.request.post(`/api/rooms/${roomId}/messages/schedule`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { content: 'scheduled hello', sendAt },
  });
  expect(queued.ok()).toBeTruthy();

  await page.getByTestId('composer').fill('x');
  await page.getByTestId('schedule-open').click();
  await expect(page.getByTestId('schedule-dialog')).toBeVisible();
  await expect(page.getByTestId('scheduled-item')).toContainText('scheduled hello');
  await page.keyboard.press('Escape');

  await expect(
    page.getByTestId('message').filter({ hasText: 'scheduled hello' }),
  ).toHaveCount(1, { timeout: 20_000 });

  await context.close();
});

test('edits and cancels a scheduled message', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_sched_edit_${suffix}`);
  await createRoom(page, `sched-edit-room-${suffix}`);
  const roomId = Number(page.url().split('/').pop());
  const token = await page.evaluate(() => localStorage.getItem('bfa_token'));
  const sendAtDate = new Date(Date.now() + 5 * 60_000);
  sendAtDate.setSeconds(37, 0);
  const sendAt = sendAtDate.toISOString();
  const queued = await page.request.post(`/api/rooms/${roomId}/messages/schedule`, {
    headers: { Authorization: `Bearer ${token}` },
    data: { content: 'edit me', sendAt },
  });
  expect(queued.ok()).toBeTruthy();
  const queuedBody = await queued.json();

  await page.getByTestId('composer').fill('draft keeps');
  await page.getByTestId('schedule-open').click();
  await expect(page.getByTestId('schedule-dialog')).toBeVisible();
  await page.getByTestId('scheduled-edit').click();
  await expect(page.getByTestId('schedule-content')).toHaveValue('edit me');
  await page.getByTestId('schedule-content').fill('edited scheduled');
  await page.getByTestId('schedule-submit').click();
  await expect(
    page.locator('.el-message').filter({ hasText: '已更新定时消息' }),
  ).toBeVisible();
  await expect(page.getByTestId('scheduled-item')).toContainText('edited scheduled');

  // Changing only the content must not truncate the row's seconds/time.
  const listed = await page.request.get(`/api/rooms/${roomId}/messages/scheduled`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const listedBody = await listed.json();
  const edited = listedBody.messages.find(
    (item: { id: number }) => item.id === queuedBody.scheduled.id,
  );
  expect(new Date(edited.sendAt).getTime()).toBe(
    new Date(queuedBody.scheduled.sendAt).getTime(),
  );

  await page.getByTestId('scheduled-cancel').click();
  await expect(
    page.locator('.el-message').filter({ hasText: '已取消定时消息' }),
  ).toBeVisible();
  await expect(page.getByTestId('scheduled-item')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('composer')).toHaveValue('draft keeps');

  await context.close();
});

test('jumps to the unread divider', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const roomName = `jump-unread-room-${suffix}`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, `e2e_jump_a_${suffix}`);
  await createRoom(pageA, roomName);
  const roomId = Number(pageA.url().split('/').pop());
  await pageA.evaluate(
    async ({ roomId, count }) => {
      const socket = window.__socket;
      if (!socket) {
        throw new Error('__socket missing');
      }
      for (let index = 0; index < count; index += 1) {
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        socket.emit(
          'message:send',
          {
            roomId,
            content: `unread seed ${index}`,
            clientMsgId: `unread-${index}`,
          },
          (result) => {
            if (result?.ok) {
              resolve();
            } else {
              reject(new Error('send failed'));
            }
          },
        );
        await promise;
      }
    },
    { roomId, count: 30 },
  );

  await register(pageB, `e2e_jump_b_${suffix}`);
  const token = await pageB.evaluate(() => localStorage.getItem('bfa_token'));
  const join = await pageB.request.post(`/api/rooms/${roomId}/join`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(join.ok()).toBe(true);
  await pageB.goto(`/rooms/${roomId}`);
  await expect(pageB.locator('.message-list')).toBeVisible();
  await expect(pageB.getByTestId('unread-divider')).not.toBeInViewport();

  await pageB.locator('.message-list').hover();
  await pageB.mouse.wheel(0, -2000);
  await expect(pageB.getByTestId('jump-unread')).toBeVisible();
  await pageB.getByTestId('jump-unread').click();
  await expect(pageB.getByTestId('unread-divider')).toBeInViewport();

  await contextA.close();
  await contextB.close();
});

test('exports personal data as JSON and ZIP', async ({ browser }) => {
  test.setTimeout(90_000);
  const suffix = Date.now().toString().slice(-8);
  const username = `e2e_export_${suffix}`;
  const roomName = `export-room-${suffix}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, username);
  await createRoom(page, roomName);
  const png = await readFile('e2e/fixtures/pixel-64.png');
  await page.getByTestId('attach-input').setInputFiles({
    name: 'export.png',
    mimeType: 'image/png',
    buffer: png,
  });
  await send(page, 'my export message');

  await page.getByTitle('个人设置').click();
  const profile = page.locator('.el-dialog').filter({ hasText: '个人设置' });
  const downloadPromise = page.waitForEvent('download');
  await profile.getByTestId('me-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^me-export-\d+\.json$/);
  const path = await download.path();
  if (path === null) {
    throw new Error('download has no path');
  }
  const data = JSON.parse(await readFile(path, 'utf8'));
  expect(data.profile.username).toBe(username);
  expect(data.rooms.some((room: { name: string }) => room.name === roomName)).toBe(true);
  expect(
    data.messages.some((message: { content: string }) => message.content === 'my export message'),
  ).toBe(true);
  expect(data.truncated).toBe(false);
  await expect(
    page.locator('.el-message').filter({ hasText: '已导出个人数据' }),
  ).toBeVisible();

  // A slow blob (large export / attachment) must outlive the 30s JSON
  // timeout. Delay only the ZIP response, then verify the download completes.
  await page.route('**/api/me/export**', async (route) => {
    if (route.request().url().includes('format=zip')) {
      await new Promise((resolve) => setTimeout(resolve, 31_000));
    }
    await route.continue();
  });
  const zipPromise = page.waitForEvent('download');
  await profile.getByTestId('me-export-zip').click();
  const zip = await zipPromise;
  await page.unroute('**/api/me/export**');
  expect(zip.suggestedFilename()).toMatch(/^me-export-\d+\.zip$/);
  const zipPath = await zip.path();
  if (zipPath === null) {
    throw new Error('zip has no path');
  }
  const zipBytes = await readFile(zipPath);
  expect(zipBytes.subarray(0, 2).toString()).toBe('PK');
  expect(zipBytes.byteLength).toBeGreaterThan(200);
  await expect(
    page.locator('.el-message').filter({ hasText: '已导出个人数据（含附件）' }),
  ).toBeVisible();

  await context.close();
});

test('marks every room read from the room list', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const roomName = `readall-room-${suffix}`;
  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, `e2e_readall_a_${suffix}`);
  await createRoom(pageA, roomName);
  const roomId = Number(pageA.url().split('/').pop());

  await register(pageB, `e2e_readall_b_${suffix}`);
  const tokenB = await pageB.evaluate(() => localStorage.getItem('bfa_token'));
  const join = await pageB.request.post(`/api/rooms/${roomId}/join`, {
    headers: { Authorization: `Bearer ${tokenB}` },
  });
  expect(join.ok()).toBe(true);

  await send(pageA, 'unread hello');
  await pageB.goto('/rooms');
  const card = pageB.getByTestId('room-item').filter({ hasText: roomName });
  await expect(card.locator('.unread')).toHaveText('1');
  await expect(pageB.getByTestId('rooms-read-all')).toBeVisible();

  await pageB.getByTestId('rooms-read-all').click();
  await expect(
    pageB.locator('.el-message').filter({ hasText: '已将 1 个房间标为已读' }),
  ).toBeVisible();
  await expect(pageB.getByTestId('rooms-read-all')).toHaveCount(0);
  await expect(card.locator('.unread')).toHaveCount(0);

  await contextA.close();
  await contextB.close();
});

test('archives and restores a room', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_arch_${suffix}`);
  const roomA = `archive-a-${suffix}`;
  const roomB = `archive-b-${suffix}`;
  await createRoom(page, roomA);
  await page.goto('/rooms');
  await createRoom(page, roomB);
  await page.goto('/rooms');

  const cardA = page.getByTestId('room-item').filter({ hasText: roomA });
  await cardA.click({ button: 'right' });
  await page.getByTestId('room-menu-archive').click();
  await expect(cardA).toHaveCount(0);
  await expect(page.getByTestId('room-item')).toHaveCount(1);

  await page.getByTestId('room-filter-archived').click();
  await expect(cardA).toBeVisible();
  await expect(page.getByTestId('room-item')).toHaveCount(1);
  await cardA.click({ button: 'right' });
  await page.getByTestId('room-menu-archive').click();

  await page.getByTestId('room-filter-all').click();
  await expect(page.getByTestId('room-item')).toHaveCount(2);

  await context.close();
});

test('adds a custom emoji reaction and remembers it', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_custom_${suffix}`);
  await createRoom(page, `custom-room-${suffix}`);
  await send(page, 'custom reaction target');

  const message = page
    .getByTestId('message')
    .filter({ hasText: 'custom reaction target' })
    .last();
  await message.hover();
  await message.getByRole('button', { name: '表情' }).click();
  await message.getByTestId('custom-emoji-input').fill('🚀');
  await message.getByTestId('custom-emoji-add').click();

  const chip = message.locator('.reaction-chip').filter({ hasText: '🚀' });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText('1');

  await page.reload();
  const reloaded = page
    .getByTestId('message')
    .filter({ hasText: 'custom reaction target' })
    .last();
  await expect(reloaded.locator('.reaction-chip').filter({ hasText: '🚀' })).toBeVisible();
  await reloaded.hover();
  await reloaded.getByRole('button', { name: '表情' }).click();
  await expect(
    reloaded.getByRole('button', { name: '自定义表情 🚀' }),
  ).toBeVisible();

  await context.close();
});

test('creates a poll and broadcasts votes', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_poll_a_${suffix}`;
  const voter = `e2e_poll_b_${suffix}`;
  const question = `poll-question-${suffix}`;

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, `poll-room-${suffix}`);
  const roomId = pageA.url().split('/').pop() ?? '';

  await pageA.getByTestId('poll-open').click();
  await pageA.getByTestId('poll-question').fill(question);
  await pageA.getByTestId('poll-option-0').fill('选项甲');
  await pageA.getByTestId('poll-option-1').fill('选项乙');
  await pageA.getByTestId('poll-submit').click();

  const card = pageA.getByTestId('poll-card').filter({ hasText: question });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('poll-option')).toHaveCount(2);
  await expect(card).toContainText('0 人参与');

  await card.getByTestId('poll-option').first().click();
  await card.getByTestId('poll-submit').click();
  await expect(card).toContainText('1 人参与');
  await expect(card.getByTestId('poll-option').first()).toContainText('已投');

  await register(pageB, voter);
  const token = await pageB.evaluate(() => localStorage.getItem('bfa_token'));
  const join = await pageB.request.post(`/api/rooms/${roomId}/join`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(join.ok()).toBe(true);
  await pageB.goto(`/rooms/${roomId}`);
  const cardB = pageB.getByTestId('poll-card').filter({ hasText: question });
  await expect(cardB).toBeVisible();
  await cardB.getByTestId('poll-option').nth(1).click();
  await cardB.getByTestId('poll-submit').click();
  await expect(cardB).toContainText('2 人参与');

  await expect(card).toContainText('2 人参与');
  await expect(card.getByTestId('poll-option').nth(1)).toContainText('1');
  await expect(card.getByTestId('poll-option').first()).toHaveAttribute(
    'title',
    new RegExp(owner),
  );
  await expect(card.getByTestId('poll-option').nth(1)).toHaveAttribute(
    'title',
    new RegExp(voter),
  );

  const downloadPromise = pageA.waitForEvent('download');
  await card.getByTestId('poll-export').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/^poll-\d+\.csv$/);
  const downloadPath = await download.path();
  if (downloadPath === null) {
    throw new Error('poll export has no path');
  }
  const csv = await readFile(downloadPath, 'utf8');
  expect(csv).toContain('option,votes,voters');
  expect(csv).toContain('选项甲');

  await card.getByTestId('poll-close').click();
  await pageA.locator('.el-message-box__btns .el-button--primary').click();
  await expect(card).toContainText('已截止');
  await expect(card.getByTestId('poll-option').first()).toBeDisabled();
  await expect(cardB).toContainText('已截止');

  await pageA.reload();
  const reloadedCard = pageA.getByTestId('poll-card').filter({ hasText: question });
  await expect(reloadedCard).toBeVisible();
  await expect(reloadedCard).toContainText('2 人参与');

  await contextA.close();
  await contextB.close();
});

test('uploads image and file attachments with a message', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_att_a_${suffix}`;
  const member = `e2e_att_b_${suffix}`;

  const contextA = await browser.newContext({ acceptDownloads: true });
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await register(pageA, owner);
  await createRoom(pageA, `attach-room-${suffix}`);
  const roomId = pageA.url().split('/').pop() ?? '';

  const png = await readFile('e2e/fixtures/pixel-64.png');
  await pageA.getByTestId('attach-input').setInputFiles([
    { name: 'pixel.png', mimeType: 'image/png', buffer: png },
    { name: 'pixel2.png', mimeType: 'image/png', buffer: png },
    { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('attachment body') },
  ]);
  await expect(pageA.getByTestId('attach-chip')).toHaveCount(3);
  await expect(pageA.getByTestId('send')).toBeEnabled();
  await pageA.getByTestId('send').click();

  const message = pageA
    .getByTestId('message')
    .filter({ has: pageA.getByTestId('attachment-image') })
    .last();
  await expect(message.getByTestId('attachment-image')).toHaveCount(2);
  await expect(message.getByTestId('attachment-image').first()).toHaveAttribute('src', /^blob:/);
  await expect(message.getByTestId('attachment-file')).toContainText('notes.txt');
  await expect.poll(
    async () => message.getByTestId('attachment-image').first().evaluate((node) => (node as HTMLImageElement).naturalWidth),
  ).toBe(64);
  await expect(pageA.getByTestId('attach-tray')).toHaveCount(0);

  await message.getByTestId('attachment-image-open').first().click();
  await expect(pageA.getByTestId('image-lightbox')).toBeVisible();
  await expect(pageA.getByTestId('lightbox-image')).toHaveAttribute('src', /^blob:/);
  await expect(pageA.getByTestId('lightbox-name')).toHaveText('pixel.png');

  await pageA.getByTestId('lightbox-next').click();
  await expect(pageA.getByTestId('lightbox-name')).toHaveText('pixel2.png');
  await pageA.getByTestId('lightbox-prev').click();
  await expect(pageA.getByTestId('lightbox-name')).toHaveText('pixel.png');

  await pageA.getByTestId('lightbox-zoom').click();
  await expect(pageA.getByTestId('lightbox-panel')).toHaveAttribute('data-zoomed', 'true');
  await pageA.getByTestId('lightbox-zoom').click();
  await expect(pageA.getByTestId('lightbox-panel')).toHaveAttribute('data-zoomed', 'false');

  await pageA.getByTestId('lightbox-image').dblclick();
  await expect(pageA.getByTestId('lightbox-panel')).toHaveAttribute('data-zoomed', 'true');
  await pageA.getByTestId('lightbox-image').dblclick();
  await expect(pageA.getByTestId('lightbox-panel')).toHaveAttribute('data-zoomed', 'false');
  await pageA.keyboard.press('+');
  await expect(pageA.getByTestId('lightbox-panel')).toHaveAttribute('data-zoomed', 'true');
  await pageA.keyboard.press('0');
  await expect(pageA.getByTestId('lightbox-panel')).toHaveAttribute('data-zoomed', 'false');

  await pageA.keyboard.press('ArrowRight');
  await expect(pageA.getByTestId('lightbox-name')).toHaveText('pixel2.png');
  await pageA.keyboard.press('ArrowLeft');
  await expect(pageA.getByTestId('lightbox-name')).toHaveText('pixel.png');

  const stage = await pageA.getByTestId('lightbox-stage').boundingBox();
  const image = await pageA.getByTestId('lightbox-image').boundingBox();
  if (stage === null || image === null) {
    throw new Error('lightbox has no box');
  }
  const startY = image.y + image.height / 2;
  await pageA.mouse.move(image.x + image.width / 2, startY);
  await pageA.mouse.down();
  await pageA.mouse.move(stage.x + stage.width * 0.25, startY, { steps: 5 });
  await pageA.mouse.up();
  await expect(pageA.getByTestId('lightbox-name')).toHaveText('pixel2.png');

  const nextImage = await pageA.getByTestId('lightbox-image').boundingBox();
  if (nextImage === null) {
    throw new Error('next lightbox image has no box');
  }
  await pageA.mouse.move(nextImage.x + nextImage.width / 2, startY);
  await pageA.mouse.down();
  await pageA.mouse.move(stage.x + stage.width * 0.75, startY, { steps: 5 });
  await pageA.mouse.up();
  await expect(pageA.getByTestId('lightbox-name')).toHaveText('pixel.png');

  await pageA.keyboard.press('Escape');
  await expect(pageA.getByTestId('image-lightbox')).toHaveCount(0);

  const downloadPromise = pageA.waitForEvent('download');
  await message.getByTestId('attachment-download').click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('notes.txt');

  await register(pageB, member);
  const token = await pageB.evaluate(() => localStorage.getItem('bfa_token'));
  const join = await pageB.request.post(`/api/rooms/${roomId}/join`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(join.ok()).toBe(true);
  await pageB.goto(`/rooms/${roomId}`);
  const messageB = pageB
    .getByTestId('message')
    .filter({ has: pageB.getByTestId('attachment-image') })
    .last();
  await expect(messageB.getByTestId('attachment-image')).toHaveCount(2);
  await expect(messageB.getByTestId('attachment-image').first()).toHaveAttribute('src', /^blob:/);

  await pageA.reload();
  await expect(
    pageA.getByTestId('message').filter({ has: pageA.getByTestId('attachment-image') }).last(),
  ).toBeVisible();

  await contextA.close();
  await contextB.close();
});

test('records and plays a voice message', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext({ permissions: ['microphone'] });
  const page = await context.newPage();

  await register(page, `e2e_voice_${suffix}`);
  await createRoom(page, `voice-room-${suffix}`);

  const record = page.getByTestId('record-audio');
  await record.click();
  await expect(page.getByTestId('record-timer')).toBeVisible();
  await page.waitForTimeout(1500);
  await record.click();

  await expect(page.getByTestId('attach-chip')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId('attach-uploading')).toHaveCount(0);
  await page.getByTestId('send').click();

  const message = page
    .getByTestId('message')
    .filter({ has: page.getByTestId('attachment-audio') })
    .last();
  const audio = message.getByTestId('attachment-audio');
  await expect(audio).toBeVisible();
  await expect(audio).toHaveAttribute('src', /^blob:/);

  await page.reload();
  await expect(
    page.getByTestId('message').filter({ has: page.getByTestId('attachment-audio') }).last(),
  ).toBeVisible();

  await context.close();
});

test('creates an anonymous poll and restores my ballot', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_anonpoll_${suffix}`);
  await createRoom(page, `anonpoll-room-${suffix}`);
  const question = `anon-question-${suffix}`;

  await page.getByTestId('poll-open').click();
  await page.getByTestId('poll-question').fill(question);
  await page.getByTestId('poll-option-0').fill('匿名甲');
  await page.getByTestId('poll-option-1').fill('匿名乙');
  await page.getByTestId('poll-anonymous').check();
  await page.getByTestId('poll-submit').click();

  const card = page.getByTestId('poll-card').filter({ hasText: question });
  await expect(card).toBeVisible();
  await expect(card.getByTestId('poll-anonymous-tag')).toHaveText('匿名');
  await card.getByTestId('poll-option').first().click();
  await card.getByTestId('poll-submit').click();
  await expect(card).toContainText('1 人参与');
  await expect(card.getByTestId('poll-option').first()).toContainText('已投');

  await page.reload();
  const reloaded = page.getByTestId('poll-card').filter({ hasText: question });
  await expect(reloaded.getByTestId('poll-anonymous-tag')).toHaveText('匿名');
  await expect(reloaded.getByTestId('poll-option').first()).toContainText('已投');
  await expect(reloaded).toContainText('1 人参与');

  await context.close();
});

test('browses room media and jumps to the message', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_media_${suffix}`;
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, owner);
  await createRoom(page, `media-room-${suffix}`);

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=',
    'base64',
  );
  await page.getByTestId('attach-input').setInputFiles([
    { name: 'gallery.png', mimeType: 'image/png', buffer: png },
    { name: 'gallery.txt', mimeType: 'text/plain', buffer: Buffer.from('gallery file') },
  ]);
  await expect(page.getByTestId('attach-chip')).toHaveCount(2);
  await page.getByTestId('send').click();
  await expect(
    page.getByTestId('message').filter({ has: page.getByTestId('attachment-image') }).last(),
  ).toBeVisible();

  await page.getByTestId('media-open').click();
  const gallery = page.getByTestId('media-gallery');
  await expect(gallery).toBeVisible();
  await expect(gallery.getByTestId('media-item-image')).toHaveCount(1);
  await expect(gallery.getByTestId('media-item-file')).toHaveCount(1);

  await gallery.getByTestId('media-search').fill('gallery.txt');
  await expect(gallery.getByTestId('media-item-file')).toHaveCount(1);
  await expect(gallery.getByTestId('media-item-image')).toHaveCount(0);
  await gallery.getByTestId('media-search').fill('');
  await expect(gallery.getByTestId('media-item-image')).toHaveCount(1);

  await gallery.getByTestId('media-filter-image').click();
  await expect(gallery.getByTestId('media-item-file')).toHaveCount(0);
  await expect(gallery.getByTestId('media-item-image')).toHaveAttribute('src', /^blob:/);
  await gallery.getByTestId('media-item-image').click();
  await expect(gallery).toHaveCount(0);
  await expect(page.locator('.msg.highlight')).toBeVisible();

  await page.getByTestId('media-open').click();
  await page.getByTestId('media-filter-file').click();
  await expect(page.getByTestId('media-item-file')).toContainText('gallery.txt');

  await page.getByTestId('media-sender').selectOption({ label: owner });
  await expect(page.getByTestId('media-item-file')).toContainText('gallery.txt');

  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  await page.getByTestId('media-from').fill(tomorrow);
  await expect(page.getByTestId('media-empty')).toBeVisible();
  await page.getByTestId('media-from').fill('');
  await expect(page.getByTestId('media-item-file')).toContainText('gallery.txt');

  await page.getByTestId('media-from').fill(tomorrow);
  await page.getByTestId('media-to').fill(
    new Date().toISOString().slice(0, 10),
  );
  await expect(page.getByTestId('media-range-error')).toBeVisible();
  await page.getByTestId('media-from').fill('');
  await page.getByTestId('media-to').fill('');

  const archivePromise = page.waitForEvent('download');
  await page.getByTestId('media-download-all').click();
  const archive = await archivePromise;
  expect(archive.suggestedFilename()).toMatch(/^room-\d+-media-.*\.zip$/);
  const archivePath = await archive.path();
  if (archivePath === null) {
    throw new Error('media archive has no path');
  }
  const archiveBytes = await readFile(archivePath);
  expect(archiveBytes.subarray(0, 2).toString()).toBe('PK');

  await page.getByTestId('media-select').first().check();
  await page.getByTestId('media-bulk-delete').click();
  await page.locator('.el-message-box__btns .el-button--primary').click();
  await expect(
    page.locator('.el-message').filter({ hasText: '已删除 1 条消息' }),
  ).toBeVisible();
  await expect(page.getByTestId('media-item-file')).toHaveCount(0);
  await page.getByTestId('media-close').click();
  await expect(page.locator('.msg.deleted').filter({ hasText: '消息已撤回' })).toBeVisible();

  await context.close();
});

test('uploads and plays a video attachment', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_video_${suffix}`);
  await createRoom(page, `video-room-${suffix}`);
  const video = await readFile('e2e/fixtures/tiny.webm');
  await page.getByTestId('attach-input').setInputFiles({
    name: 'clip.webm',
    mimeType: 'video/webm',
    buffer: video,
  });
  await expect(page.getByTestId('attach-chip')).toHaveCount(1);
  await page.getByTestId('send').click();

  const message = page
    .getByTestId('message')
    .filter({ has: page.getByTestId('attachment-video') })
    .last();
  await expect(message.getByTestId('attachment-video')).toBeVisible();
  await expect(message.getByTestId('attachment-video')).toHaveAttribute(
    'src',
    /^blob:/,
  );
  await expect.poll(
    async () => message.getByTestId('attachment-video').getAttribute('poster'),
  ).toMatch(/^data:image\/jpeg;base64,/);

  await page.getByTestId('media-open').click();
  await page.getByTestId('media-filter-video').click();
  await expect(page.getByTestId('media-item-video')).toBeVisible();
  await expect.poll(
    async () => page.getByTestId('media-item-video').getAttribute('poster'),
  ).toMatch(/^data:image\/jpeg;base64,/);
  await expect(page.getByTestId('media-item-file')).toHaveCount(0);

  await context.close();
});

test('lists and opens drafts across rooms', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_drafts_${suffix}`);
  await createRoom(page, `drafts-a-${suffix}`);
  const firstUrl = page.url();
  const firstRoomId = firstUrl.split('/').pop() ?? '';
  const token = await page.evaluate(() => localStorage.getItem('bfa_token'));
  const headers = { Authorization: `Bearer ${token}` };
  const firstDraft = `draft first ${suffix}`;
  const seeded = await page.request.put(`/api/rooms/${firstRoomId}/draft`, {
    headers,
    data: { content: firstDraft },
  });
  expect(seeded.ok()).toBe(true);

  await page.goto('/rooms');
  await createRoom(page, `drafts-b-${suffix}`);
  const secondRoomId = page.url().split('/').pop() ?? '';
  const secondDraft = `draft second ${suffix}`;
  const seededOther = await page.request.put(`/api/rooms/${secondRoomId}/draft`, {
    headers,
    data: { content: secondDraft },
  });
  expect(seededOther.ok()).toBe(true);

  await page.keyboard.press('Control+K');
  await page.locator('.cmdk-input input').fill('草稿箱');
  await page.locator('.cmdk-item').filter({ hasText: '草稿箱' }).click();
  const dialog = page.getByTestId('drafts-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('draft-item')).toHaveCount(2);

  await page.getByTestId('draft-item').filter({ hasText: firstDraft }).click();
  await expect(page).toHaveURL(new RegExp(`/rooms/${firstRoomId}$`));
  await expect(page.getByTestId('composer')).toHaveValue(firstDraft);

  await page.keyboard.press('Control+K');
  await page.locator('.cmdk-input input').fill('草稿箱');
  await page.locator('.cmdk-item').filter({ hasText: '草稿箱' }).click();
  await expect(dialog).toBeVisible();
  await page.getByRole('button', { name: `删除草稿：drafts-b-${suffix}` }).click();
  await expect(page.getByTestId('draft-item')).toHaveCount(1);
  await expect(page.getByTestId('draft-item')).not.toContainText(secondDraft);

  await context.close();
});

test('saves a message and opens it from the saved panel', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const context = await browser.newContext();
  const page = await context.newPage();

  await register(page, `e2e_saved_${suffix}`);
  await createRoom(page, `saved-room-${suffix}`);
  await send(page, 'saved target');
  const message = page
    .getByTestId('message')
    .filter({ hasText: 'saved target' })
    .last();
  await message.click({ button: 'right' });
  await page.getByTestId('save-message').click();
  await expect(page.locator('.el-message').filter({ hasText: '消息已保存' })).toBeVisible();

  await send(page, 'saved other');
  const other = page.getByTestId('message').filter({ hasText: 'saved other' }).last();
  await other.click({ button: 'right' });
  await page.getByTestId('save-message').click();
  await expect(page.locator('.el-message').filter({ hasText: '消息已保存' })).toBeVisible();

  await page.keyboard.press('Control+K');
  await page.locator('.cmdk-input input').fill('已保存');
  await page.locator('.cmdk-item').filter({ hasText: '已保存消息' }).click();
  const dialog = page.getByTestId('saved-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('saved-item')).toHaveCount(2);
  await page.getByTestId('saved-search').fill('target');
  await expect(page.getByTestId('saved-item')).toHaveCount(1);
  await expect(page.getByTestId('saved-item')).toContainText('saved target');
  await page.getByTestId('saved-search').fill('no such saved text');
  await expect(page.getByTestId('saved-item')).toHaveCount(0);
  await page.getByTestId('saved-search').fill('');
  await expect(page.getByTestId('saved-item')).toHaveCount(2);
  const item = page.getByTestId('saved-item').filter({ hasText: 'saved target' });
  await expect(item).toBeVisible();
  await item.click();
  await expect(page.locator('.msg.highlight')).toContainText('saved target');

  await page.keyboard.press('Control+K');
  await page.locator('.cmdk-input input').fill('已保存');
  await page.locator('.cmdk-item').filter({ hasText: '已保存消息' }).click();
  await page
    .getByTestId('saved-row')
    .filter({ hasText: 'saved target' })
    .getByTestId('saved-remove')
    .click();
  await expect(page.getByTestId('saved-item')).toHaveCount(1);
  await page
    .getByTestId('saved-row')
    .filter({ hasText: 'saved other' })
    .getByTestId('saved-remove')
    .click();
  await expect(page.getByTestId('saved-item')).toHaveCount(0);

  await context.close();
});

test('aggregates desktop notifications per room', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_notif_a_${suffix}`;
  const sender = `e2e_notif_b_${suffix}`;
  const roomName = `notif-agg-${suffix}`;

  const ownerContext = await browser.newContext();
  const senderContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const ownerPageReady = ownerPage.addInitScript(() => {
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title: string, options?: { body?: string }) {
        window.__notifications = window.__notifications ?? [];
        window.__notifications.push({ title, body: options?.body });
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', {
      value: FakeNotification,
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', {
      get: () => true,
      configurable: true,
    });
    localStorage.setItem('bfa_notify', '1');
    localStorage.setItem('bfa_notify_mode', 'all');
  });
  await ownerPageReady;
  const senderPage = await senderContext.newPage();

  await register(ownerPage, owner);
  await createRoom(ownerPage, roomName);
  await register(senderPage, sender);
  await senderPage.getByTestId('tab-public').click();
  await senderPage.getByTestId('room-item').filter({ hasText: roomName }).click();
  await senderPage.waitForURL(/\/rooms\/\d+$/);

  await send(senderPage, 'notify one');
  await send(senderPage, 'notify two');
  await expect
    .poll(async () =>
      ownerPage.evaluate(() => window.__notifications?.length ?? 0),
    )
    .toBe(1);
  const notifications = await ownerPage.evaluate(() => window.__notifications);
  expect(notifications?.[0]?.title).toContain('2 条新消息');

  await ownerContext.close();
  await senderContext.close();
});

test('suppresses desktop notifications during DND', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_dnd_a_${suffix}`;
  const sender = `e2e_dnd_b_${suffix}`;
  const roomName = `dnd-room-${suffix}`;

  const ownerContext = await browser.newContext();
  const senderContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const ownerReady = ownerPage.addInitScript(() => {
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      constructor(title: string, options?: { body?: string }) {
        window.__notifications = window.__notifications ?? [];
        window.__notifications.push({ title, body: options?.body });
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', {
      value: FakeNotification,
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', {
      get: () => true,
      configurable: true,
    });
    localStorage.setItem('bfa_notify', '1');
    localStorage.setItem('bfa_notify_mode', 'all');
  });
  await ownerReady;
  const senderPage = await senderContext.newPage();

  await register(ownerPage, owner);
  await createRoom(ownerPage, roomName);
  await register(senderPage, sender);
  await senderPage.getByTestId('tab-public').click();
  await senderPage.getByTestId('room-item').filter({ hasText: roomName }).click();
  await senderPage.waitForURL(/\/rooms\/\d+$/);

  const times = await ownerPage.evaluate(() => {
    const pad = (value: number) => String(value).padStart(2, '0');
    const format = (date: Date) =>
      `${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const now = Date.now();
    return {
      start: format(new Date(now - 60 * 60 * 1000)),
      end: format(new Date(now + 60 * 60 * 1000)),
      laterStart: format(new Date(now + 2 * 60 * 60 * 1000)),
      laterEnd: format(new Date(now + 3 * 60 * 60 * 1000)),
    };
  });

  await ownerPage.getByTitle('个人设置').click();
  await ownerPage.getByTestId('dnd-start').fill(times.start);
  await ownerPage.getByTestId('dnd-end').fill(times.end);
  await ownerPage.getByTestId('dnd-save').click();
  await expect(
    ownerPage.locator('.el-message').filter({ hasText: '免打扰时段已保存' }),
  ).toBeVisible();
  await ownerPage.keyboard.press('Escape');
  await expect(ownerPage.getByTestId('dnd-start')).toBeHidden();

  await send(senderPage, 'dnd suppressed');
  await ownerPage.waitForTimeout(1200);
  expect(await ownerPage.evaluate(() => window.__notifications?.length ?? 0)).toBe(0);

  await ownerPage.getByTitle('个人设置').click();
  await ownerPage.getByTestId('dnd-start').fill(times.laterStart);
  await ownerPage.getByTestId('dnd-end').fill(times.laterEnd);
  await ownerPage.getByTestId('dnd-save').click();
  await expect(
    ownerPage.locator('.el-message').filter({ hasText: '免打扰时段已保存' }),
  ).toBeVisible();
  await ownerPage.keyboard.press('Escape');

  await send(senderPage, 'dnd allowed');
  await expect
    .poll(async () => ownerPage.evaluate(() => window.__notifications?.length ?? 0))
    .toBe(1);

  await ownerContext.close();
  await senderContext.close();
});

test('desktop notification click jumps to the triggering message', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_notifjump_a_${suffix}`;
  const sender = `e2e_notifjump_b_${suffix}`;
  const roomName = `notif-jump-${suffix}`;

  const ownerContext = await browser.newContext();
  const senderContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const ownerReady = ownerPage.addInitScript(() => {
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        window.__notifications = window.__notifications ?? [];
        window.__notifications.push({ title, body: options?.body });
        window.__notificationInstances = window.__notificationInstances ?? [];
        window.__notificationInstances.push(this);
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', {
      value: FakeNotification,
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', {
      get: () => true,
      configurable: true,
    });
    // The room view drops ?seq= once it has jumped to the message, so record
    // every router navigation target instead of racing that rewrite.
    const pushState = history.pushState.bind(history);
    history.pushState = (data: unknown, unused: string, url?: string | URL | null) => {
      window.__navUrls = window.__navUrls ?? [];
      window.__navUrls.push(String(url));
      pushState(data, unused, url);
    };
    localStorage.setItem('bfa_notify', '1');
    localStorage.setItem('bfa_notify_mode', 'all');
  });
  await ownerReady;
  const senderPage = await senderContext.newPage();

  await register(ownerPage, owner);
  await createRoom(ownerPage, roomName);
  const roomId = Number(new URL(ownerPage.url()).pathname.split('/').pop());
  // Step out of the room: the toast is what has to bring the owner back.
  await ownerPage.goto('/rooms');
  await expect(ownerPage.getByTestId('create-room')).toBeVisible();

  await register(senderPage, sender);
  await senderPage.getByTestId('tab-public').click();
  await senderPage.getByTestId('room-item').filter({ hasText: roomName }).click();
  await senderPage.waitForURL(/\/rooms\/\d+$/);
  await send(senderPage, 'notify jump one');
  await send(senderPage, 'notify jump two');
  // The newest line of the batch is the toast's target.
  const seq = Number(
    await senderPage
      .getByTestId('message')
      .filter({ hasText: 'notify jump two' })
      .getAttribute('data-seq'),
  );
  expect(seq).toBeGreaterThan(0);

  await expect
    .poll(() =>
      ownerPage.evaluate(() => window.__notificationInstances?.length ?? 0),
    )
    .toBe(1);
  expect(
    await ownerPage.evaluate(() => window.__notifications?.[0]?.title),
  ).toContain('2 条新消息');
  await ownerPage.evaluate(() => {
    window.__notificationInstances?.[0]?.onclick?.();
  });
  await expect
    .poll(() =>
      ownerPage.evaluate(
        (target) => (window.__navUrls ?? []).some((url) => url.endsWith(target)),
        `/rooms/${roomId}?seq=${seq}`,
      ),
    )
    .toBe(true);
  await expect(ownerPage).toHaveURL(new RegExp(`/rooms/${roomId}`));
  await expect(ownerPage.locator('.msg.highlight')).toContainText('notify jump two');

  await ownerContext.close();
  await senderContext.close();
});

test('plays an optional beep for desktop notifications', async ({ browser }) => {
  const suffix = Date.now().toString().slice(-8);
  const owner = `e2e_beep_a_${suffix}`;
  const sender = `e2e_beep_b_${suffix}`;
  const roomName = `beep-room-${suffix}`;

  const ownerContext = await browser.newContext();
  const senderContext = await browser.newContext();
  const ownerPage = await ownerContext.newPage();
  const ownerReady = ownerPage.addInitScript(() => {
    class FakeNotification {
      static permission = 'granted';
      static requestPermission = async () => 'granted';
      onclick: (() => void) | null = null;
      constructor(title: string, options?: { body?: string }) {
        window.__notifications = window.__notifications ?? [];
        window.__notifications.push({ title, body: options?.body });
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', {
      value: FakeNotification,
      configurable: true,
    });
    Object.defineProperty(document, 'hidden', {
      get: () => true,
      configurable: true,
    });
    // Only the oscillator start matters: one toast, one tone. The store's
    // stop()/close() calls are the cleanup path and are not asserted here.
    class FakeAudioContext {
      state = 'running';
      currentTime = 0;
      destination = null;
      createOscillator() {
        return {
          type: 'sine',
          frequency: { value: 0 },
          onended: null as (() => void) | null,
          connect() {},
          start() {
            window.__beeps = (window.__beeps ?? 0) + 1;
          },
          stop() {
            this.onended?.();
          },
        };
      }
      createGain() {
        return {
          gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} },
          connect() {},
        };
      }
      close() {
        return Promise.resolve();
      }
    }
    Object.defineProperty(window, 'AudioContext', {
      value: FakeAudioContext,
      configurable: true,
    });
    localStorage.setItem('bfa_notify', '1');
    localStorage.setItem('bfa_notify_mode', 'all');
    localStorage.setItem('bfa_notify_sound', '1');
  });
  await ownerReady;
  const senderPage = await senderContext.newPage();

  await register(ownerPage, owner);
  await createRoom(ownerPage, roomName);
  await register(senderPage, sender);
  await senderPage.getByTestId('tab-public').click();
  await senderPage.getByTestId('room-item').filter({ hasText: roomName }).click();
  await senderPage.waitForURL(/\/rooms\/\d+$/);

  await send(senderPage, 'beep one');
  await expect
    .poll(() => ownerPage.evaluate(() => window.__notifications?.length ?? 0))
    .toBe(1);
  await expect.poll(() => ownerPage.evaluate(() => window.__beeps ?? 0)).toBe(1);

  // The toggle is read per toast, so unchecking it silences the next one.
  await ownerPage.getByTitle('个人设置').click();
  const sound = ownerPage.getByTestId('notify-sound');
  await expect(sound).toBeChecked();
  await sound.uncheck();
  expect(
    await ownerPage.evaluate(() => localStorage.getItem('bfa_notify_sound')),
  ).toBeNull();
  await ownerPage.keyboard.press('Escape');
  await expect(sound).toBeHidden();

  await send(senderPage, 'beep two');
  await expect
    .poll(() => ownerPage.evaluate(() => window.__notifications?.length ?? 0))
    .toBe(2);
  expect(await ownerPage.evaluate(() => window.__beeps ?? 0)).toBe(1);

  await ownerContext.close();
  await senderContext.close();
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

  test('swipe gestures open the sidebar and reply', async ({ browser }) => {
    const suffix = Date.now().toString().slice(-8);
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    const page = await context.newPage();

    await register(page, `e2e_swipe_${suffix}`);
    await createRoom(page, `swipe-room-${suffix}`);
    await send(page, 'gesture target');

    const swipe = async (options: {
      selector?: string;
      text?: string;
      fromX: number;
      toX: number;
    }): Promise<void> => {
      await page.evaluate(
        ({ selector, text, fromX, toX }) => {
          const element = text
            ? Array.from(document.querySelectorAll('[data-testid=message]')).find(
                (node) => node.textContent?.includes(text),
              )
            : document.querySelector(selector ?? '');
          if (!(element instanceof HTMLElement)) {
            throw new Error('swipe target missing');
          }
          const rect = element.getBoundingClientRect();
          const y = rect.top + rect.height / 2;
          const touch = (x: number) =>
            new Touch({ identifier: 1, target: element, clientX: x, clientY: y });
          const fire = (type: string, x: number | null) => {
            element.dispatchEvent(
              new TouchEvent(type, {
                bubbles: true,
                cancelable: true,
                touches: x === null ? [] : [touch(x)],
                targetTouches: x === null ? [] : [touch(x)],
                changedTouches: [touch(x ?? toX)],
              }),
            );
          };
          fire('touchstart', fromX);
          const step = (toX - fromX) / 4;
          for (let index = 1; index <= 4; index += 1) {
            fire('touchmove', fromX + step * index);
          }
          fire('touchend', null);
        },
        options,
      );
    };

    await swipe({ selector: '.chat-main', fromX: 10, toX: 130 });
    const drawer = page.locator('.el-drawer.ltr');
    await expect(drawer).toBeVisible();

    await swipe({ selector: '.el-drawer.ltr aside.sidebar', fromX: 260, toX: 120 });
    await expect(drawer).toBeHidden();

    await swipe({ text: 'gesture target', fromX: 320, toX: 220 });
    await expect(page.locator('.reply-bar')).toBeVisible();

    await context.close();
  });

  test('compact topbar moves secondary actions into the more sheet', async ({ browser }) => {
    const suffix = Date.now().toString().slice(-8);
    const roomName = `m-topbar-${suffix}`;
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();

    await register(page, `e2e_mtop_${suffix}`);
    await createRoom(page, roomName);
    await send(page, 'topbar target');

    // Title and the two primary actions stay on the bar.
    await expect(page.getByTestId('room-title')).toBeVisible();
    await expect(page.getByTestId('room-title')).toHaveText(roomName);
    await expect(page.getByTestId('search-open')).toBeVisible();
    await expect(page.getByTestId('members-open')).toBeVisible();
    await expect(page.getByTestId('more-open')).toBeVisible();

    // Secondary actions moved off the bar.
    await expect(page.getByTestId('select-mode')).toBeHidden();
    await expect(page.getByTestId('media-open')).toBeHidden();
    await expect(page.getByTestId('poll-open')).toBeHidden();
    await expect(page.getByTestId('settings-open')).toBeHidden();

    const layout = await page.evaluate(() => {
      const bar = document.querySelector<HTMLElement>('[data-testid="chat-topbar"]');
      const title = document.querySelector<HTMLElement>('[data-testid="room-title"]');
      if (!bar || !title) {
        throw new Error('topbar missing');
      }
      return {
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
        barScrollWidth: bar.scrollWidth,
        barClientWidth: bar.clientWidth,
        titleWidth: title.getBoundingClientRect().width,
      };
    });
    expect(layout.documentScrollWidth).toBeLessThanOrEqual(layout.documentClientWidth);
    expect(layout.barScrollWidth).toBeLessThanOrEqual(layout.barClientWidth + 1);
    expect(layout.titleWidth).toBeGreaterThan(80);

    // The sheet carries every action that left the bar, including settings.
    await page.getByTestId('more-open').click();
    const sheet = page.getByTestId('more-sheet');
    await expect(sheet).toBeVisible();
    await expect(page.getByTestId('more-select')).toBeVisible();
    await expect(page.getByTestId('more-media')).toBeVisible();
    await expect(page.getByTestId('more-pins')).toBeVisible();
    await expect(page.getByTestId('more-poll')).toBeVisible();
    await expect(page.getByTestId('more-bot')).toBeVisible();
    await expect(page.getByTestId('more-settings')).toBeVisible();

    await page.getByTestId('more-settings').click();
    await expect(sheet).toBeHidden();
    const settings = page.locator('.el-dialog').filter({ hasText: '房间设置' });
    await expect(settings).toBeVisible();
    await settings.getByRole('button', { name: '关闭', exact: true }).click();
    await expect(settings).toBeHidden();

    // Accessibility contract for the transcript and composer controls.
    await expect(page.locator('.message-list')).toHaveAttribute('role', 'log');
    await expect(page.locator('.message-list')).toHaveAttribute('tabindex', '0');
    await expect(page.locator('.message-list')).toHaveAttribute('aria-label', '消息列表');
    await expect(page.getByTestId('send')).toHaveAttribute('aria-label', '发送');
    await page.getByTestId('emoji-open').click();
    const emoji = page.locator('.emoji-item').first();
    await expect(emoji).toHaveAttribute('role', 'option');
    await expect(emoji).toHaveAttribute('aria-selected', 'false');

    await context.close();
  });
});
