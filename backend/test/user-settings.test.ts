import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, type RowDataPacket } from '../src/db';
import { getSettings, updateSettings } from '../src/services/settings';
import { createTestUser, tokenFor } from './helpers';

const app = createApp();

const DEFAULTS = {
  notifyMode: 'all',
  dndStart: null,
  dndEnd: null,
  dndAllowMentions: true,
};

async function settingsRowCount(userId: number): Promise<number> {
  const [rows] = await pool.query<RowDataPacket[]>(
    'SELECT COUNT(*) AS n FROM user_settings WHERE user_id = ?',
    [userId],
  );
  return Number(rows[0]?.n ?? 0);
}

describe('user settings', () => {
  // `test/setup.ts` truncates the shared tables but not `user_settings`, so the
  // per-file reset lives here.
  beforeEach(async () => {
    await pool.query('DELETE FROM user_settings');
  });

  it('defaults to notifications for everything with DND off', async () => {
    const user = await createTestUser('settings_default');

    const response = await request(app)
      .get('/api/me/settings')
      .set('Authorization', `Bearer ${tokenFor(user)}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(DEFAULTS);
    expect(await settingsRowCount(user.id)).toBe(1);
  });

  it('persists a PATCH and reflects it on the next GET', async () => {
    const user = await createTestUser('settings_patch');
    const auth = `Bearer ${tokenFor(user)}`;
    const body = {
      notifyMode: 'mention',
      dndStart: '22:00',
      dndEnd: '07:30',
      dndAllowMentions: false,
    };

    const patched = await request(app).patch('/api/me/settings').set('Authorization', auth).send(body);

    expect(patched.status).toBe(200);
    expect(patched.body).toEqual(body);

    const fetched = await request(app).get('/api/me/settings').set('Authorization', auth);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(body);

    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT notify_mode, dnd_start, dnd_end, dnd_allow_mentions
       FROM user_settings WHERE user_id = ?`,
      [user.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.notify_mode).toBe('mention');
    // MySQL stores TIME with seconds even though the API speaks HH:MM.
    expect(rows[0]?.dnd_start).toBe('22:00:00');
    expect(rows[0]?.dnd_end).toBe('07:30:00');
    expect(Number(rows[0]?.dnd_allow_mentions)).toBe(0);
  });

  it('keeps omitted fields unchanged on a partial PATCH', async () => {
    const user = await createTestUser('settings_partial');
    const auth = `Bearer ${tokenFor(user)}`;

    await request(app)
      .patch('/api/me/settings')
      .set('Authorization', auth)
      .send({ notifyMode: 'mention', dndStart: '22:00', dndEnd: '07:30', dndAllowMentions: false });

    const notifyOnly = await request(app)
      .patch('/api/me/settings')
      .set('Authorization', auth)
      .send({ notifyMode: 'all' });

    expect(notifyOnly.status).toBe(200);
    expect(notifyOnly.body).toEqual({
      notifyMode: 'all',
      dndStart: '22:00',
      dndEnd: '07:30',
      dndAllowMentions: false,
    });

    // The window is one value: a request touching it carries both ends, and an
    // omitted notifyMode keeps the current scope.
    const windowOnly = await request(app)
      .patch('/api/me/settings')
      .set('Authorization', auth)
      .send({ dndStart: '23:15', dndEnd: '06:45' });

    expect(windowOnly.status).toBe(200);
    expect(windowOnly.body).toEqual({
      notifyMode: 'all',
      dndStart: '23:15',
      dndEnd: '06:45',
      dndAllowMentions: false,
    });
  });

  it('turns DND off when both ends are cleared', async () => {
    const user = await createTestUser('settings_clear');
    const auth = `Bearer ${tokenFor(user)}`;

    await request(app)
      .patch('/api/me/settings')
      .set('Authorization', auth)
      .send({ dndStart: '22:00', dndEnd: '07:00', dndAllowMentions: false });

    const cleared = await request(app)
      .patch('/api/me/settings')
      .set('Authorization', auth)
      .send({ dndStart: null, dndEnd: null });

    expect(cleared.status).toBe(200);
    // Clearing the window does not resurrect the mention override: that is a
    // separate setting and keeps its stored value.
    expect(cleared.body).toEqual({ ...DEFAULTS, dndAllowMentions: false });

    const fetched = await request(app).get('/api/me/settings').set('Authorization', auth);
    expect(fetched.body).toEqual({ ...DEFAULTS, dndAllowMentions: false });
  });

  it('rejects malformed or incomplete DND windows with 400', async () => {
    const user = await createTestUser('settings_invalid_dnd');
    const auth = `Bearer ${tokenFor(user)}`;

    const cases = [
      // Half a window.
      { dndStart: '22:00' },
      { dndEnd: '07:00' },
      { dndStart: '22:00', dndEnd: null },
      { dndStart: null, dndEnd: '07:00' },
      // A zero-length window.
      { dndStart: '22:00', dndEnd: '22:00' },
      // Not 24-hour HH:MM.
      { dndStart: '8:00', dndEnd: '09:00' },
      { dndStart: '25:00', dndEnd: '09:00' },
      { dndStart: '22:00', dndEnd: '07:60' },
      { dndStart: '2200', dndEnd: '0700' },
    ];

    for (const body of cases) {
      const response = await request(app)
        .patch('/api/me/settings')
        .set('Authorization', auth)
        .send(body);

      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.body.error.code).toBe('INVALID_INPUT');
    }

    // Nothing was stored by the rejected requests.
    const fetched = await request(app).get('/api/me/settings').set('Authorization', auth);
    expect(fetched.body).toEqual(DEFAULTS);
  });

  it('rejects an invalid notifyMode or dndAllowMentions with 400', async () => {
    const user = await createTestUser('settings_invalid');
    const auth = `Bearer ${tokenFor(user)}`;

    const notifyMode = await request(app)
      .patch('/api/me/settings')
      .set('Authorization', auth)
      .send({ notifyMode: 'none' });
    expect(notifyMode.status).toBe(400);
    expect(notifyMode.body.error.code).toBe('INVALID_INPUT');

    const allowMentions = await request(app)
      .patch('/api/me/settings')
      .set('Authorization', auth)
      .send({ dndAllowMentions: 'yes' });
    expect(allowMentions.status).toBe(400);
    expect(allowMentions.body.error.code).toBe('INVALID_INPUT');

    const fetched = await request(app).get('/api/me/settings').set('Authorization', auth);
    expect(fetched.body).toEqual(DEFAULTS);
  });

  it('rejects an empty PATCH body with 400', async () => {
    const user = await createTestUser('settings_empty');
    const auth = `Bearer ${tokenFor(user)}`;

    const response = await request(app).patch('/api/me/settings').set('Authorization', auth).send({});

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_INPUT');
    // Validation happens before the lazy default row would be created.
    expect(await settingsRowCount(user.id)).toBe(0);
  });

  it('merges concurrent patches instead of overwriting the whole row', async () => {
    const user = await createTestUser('settings_concurrent');

    // Half the writers change only the notification mode, half only the DND
    // window. Without the row lock each one writes a full row built from its
    // own stale read, so one of the two fields is lost.
    await Promise.all([
      ...Array.from({ length: 4 }, () => updateSettings(user.id, { notifyMode: 'mention' })),
      ...Array.from({ length: 4 }, () =>
        updateSettings(user.id, { dndStart: '22:00', dndEnd: '07:00', dndAllowMentions: false }),
      ),
    ]);

    expect(await getSettings(user.id)).toEqual({
      notifyMode: 'mention',
      dndStart: '22:00',
      dndEnd: '07:00',
      dndAllowMentions: false,
    });
  });

  it('isolates settings between users', async () => {
    const alice = await createTestUser('settings_alice');
    const bob = await createTestUser('settings_bob');

    await request(app)
      .patch('/api/me/settings')
      .set('Authorization', `Bearer ${tokenFor(alice)}`)
      .send({ notifyMode: 'mention', dndStart: '22:00', dndEnd: '07:00', dndAllowMentions: false });

    const bobResponse = await request(app)
      .get('/api/me/settings')
      .set('Authorization', `Bearer ${tokenFor(bob)}`);

    expect(bobResponse.body).toEqual(DEFAULTS);
    expect(await settingsRowCount(bob.id)).toBe(1);
  });

  it('requires authentication', async () => {
    const get = await request(app).get('/api/me/settings');
    expect(get.status).toBe(401);

    const patch = await request(app).patch('/api/me/settings').send({ notifyMode: 'mention' });
    expect(patch.status).toBe(401);
  });

  it('does not insert a duplicate row on repeated GETs', async () => {
    const user = await createTestUser('settings_repeat');
    const auth = `Bearer ${tokenFor(user)}`;

    for (let i = 0; i < 3; i += 1) {
      const response = await request(app).get('/api/me/settings').set('Authorization', auth);
      expect(response.status).toBe(200);
      expect(response.body).toEqual(DEFAULTS);
    }

    expect(await settingsRowCount(user.id)).toBe(1);
  });
});
