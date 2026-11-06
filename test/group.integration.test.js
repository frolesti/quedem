import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import handler from '../api/index.js';
import { database } from '../lib/db.js';
import { encrypt } from '../lib/security.js';

test('shared plans support name-only blocks and private calendar disconnection without personal links', {
  skip: !process.env.QUEDEM_INTEGRATION
}, async t => {
  assert(process.env.DATABASE_URL, 'Integration tests require a database connection');
  process.env.APP_SECRET = 'integration-test-secret-not-production-0123456789';
  process.env.GOOGLE_CLIENT_ID ||= 'integration-client';
  process.env.GOOGLE_CLIENT_SECRET ||= 'integration-secret';
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_URL = origin;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const sql = database();

  function browser() {
    const cookies = new Map();
    return async (path, data, method = data === undefined ? 'GET' : 'POST', withOrigin = true) => {
      const response = await fetch(`${origin}/api/${path}`, {
        method, redirect: 'manual',
        headers: {
          ...(withOrigin ? { Origin: origin } : {}),
          Cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '),
          ...(data === undefined ? {} : { 'Content-Type': 'application/json' })
        },
        ...(data === undefined ? {} : { body: JSON.stringify(data) })
      });
      for (const value of response.headers.getSetCookie()) {
        const [name, ...rest] = value.split(';')[0].split('=');
        if (value.includes('Max-Age=0')) cookies.delete(name);
        else cookies.set(name, rest.join('='));
      }
      const text = await response.text();
      return { status: response.status, data: text ? JSON.parse(text) : null, headers: response.headers };
    };
  }

  const owner = browser(), guest = browser(), outsider = browser();
  const from = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const to = new Date(Date.now() + 4 * 86400000).toISOString().slice(0, 10);
  const created = await owner('events', { title: 'Temporary group integration fixture', type: 'Trobada', from, to, window: 'tarda', duration: 60 });
  assert.equal(created.status, 201);
  const code = created.data.code;
  t.after(async () => { await sql`DELETE FROM quedem_events WHERE code=${code}`; });
  const path = `events/${code}`;
  const get = async client => (await client(path)).data;
  assert.equal((await owner(`${path}/join`, { name: 'Participant Test' })).status, 200);
  const initial = await get(owner);
  assert.equal(initial.own.confirmed, true);
  assert.equal(initial.own.availableDates.length, 3);
  assert.equal(initial.proposals.length, 12);
  const [record] = await sql`SELECT session_hash, data FROM quedem_people WHERE event_code=${code}`;
  const privateTitle = 'PRIVATE integration-only commitment';
  const privateTokens = encrypt({ access: 'integration-only-not-a-real-token', expires: Date.now() + 3600000 });
  const period = { id: 'private-test', seriesId: 'private-series', start: `${from}T16:00:00Z`, end: `${from}T17:00:00Z` };
  await sql`UPDATE quedem_people SET data=${JSON.stringify({
    ...record.data, provider: 'google', tokens: privateTokens, detailsAvailable: true,
    calendars: [{ id: 'private-calendar', name: 'PRIVATE CALENDAR' }], selected: ['private-calendar'],
    busy: [period], syncedAt: new Date().toISOString(),
    seriesRules: [{ id: 'private-series', flexible: true }],
    conflicts: encrypt([{ ...period, title: privateTitle }])
  })}::jsonb WHERE event_code=${code} AND session_hash=${record.session_hash}`;

  await t.test('personal link endpoints are gone and shared invitations never expose private calendars', async () => {
    const original = await get(owner);
    assert.equal(original.own.conflicts[0].title, privateTitle);
    const publicView = await get(guest);
    assert.equal(publicView.own, null);
    assert.equal(publicView.owner, false);
    assert(!JSON.stringify(publicView).includes(privateTitle));
    assert(!JSON.stringify(publicView).includes(record.session_hash));
    assert.equal((await guest(`${path}/join`, { name: 'PARTICIPANT TEST' })).status, 409);
    for (const client of [owner, guest]) {
      for (const action of ['recover', 'recovery']) assert.equal((await client(`${path}/${action}`, {})).status, 404);
    }
  });

  await t.test('participants can switch names, leave a selection, join and return to their private participation', async () => {
    const visitor = browser();
    const first = await get(visitor);
    assert.equal((await visitor(`${path}/identify`, { participantId: first.participants[0].id })).status, 200);
    assert.equal((await get(visitor)).own.manualOnly, true);
    assert.equal((await visitor(`${path}/unidentify`, {})).status, 200);
    assert.equal((await get(visitor)).own, null);
    assert.equal((await visitor(`${path}/join`, { name: 'Different Test Participant' })).status, 200);
    const joined = await get(visitor);
    assert.equal(joined.editingId, joined.privateParticipantId);
    assert.equal((await visitor(`${path}/identify`, { participantId: first.participants[0].id })).status, 200);
    assert.equal((await get(visitor)).own.manualOnly, true);
    assert.equal((await visitor(`${path}/unidentify`, {})).status, 200);
    assert.equal((await get(visitor)).own.name, 'Different Test Participant');
    assert.equal((await visitor(`${path}/leave`, undefined, 'DELETE')).status, 200);
  });

  await t.test('duplicate names are rejected even with spacing, Unicode variants or simultaneous joins', async () => {
    const a = browser(), b = browser();
    const result = await owner('events', { title: 'Temporary duplicate-name fixture', type: 'Trobada', from, to, window: 'tarda', duration: 60 });
    assert.equal(result.status, 201);
    const other = `events/${result.data.code}`;
    try {
      await Promise.all([a(other), b(other)]);
      const attempts = await Promise.all([
        a(`${other}/join`, { name: 'Júlia   Test' }),
        b(`${other}/join`, { name: '  JÚLIA TEST  ' })
      ]);
      assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
      assert.equal((await a(other)).data.participants.length, 1);
      const duplicate = browser();
      assert.equal((await duplicate(`${other}/join`, { name: 'Ju\u0301lia Test' })).status, 409);
      assert.equal((await duplicate(`${path}/join`, { name: 'Júlia Test' })).status, 200);
      assert.equal((await duplicate(`${path}/leave`, undefined, 'DELETE')).status, 200);
    } finally { await sql`DELETE FROM quedem_events WHERE code=${result.data.code}`; }
  });

  await t.test('name selection permits only manual blocks, without modifying calendar credentials or rules', async () => {
    const id = (await get(guest)).participants[0].id;
    assert.notEqual(id, record.session_hash);
    assert.equal((await guest(`${path}/identify`, { participantId: id }, 'POST', false)).status, 403);
    assert.equal((await guest(`${path}/identify`, { participantId: 'foreign-person' })).status, 404);
    assert.equal((await guest(`${path}/identify`, { participantId: id })).status, 200);
    const limited = await get(guest);
    assert.equal(limited.own.manualOnly, true);
    assert.equal(limited.editingId, id);
    assert.equal(limited.owner, false);
    assert.deepEqual(limited.own.calendars, []);
    assert.deepEqual(limited.own.conflicts, []);
    assert.deepEqual(limited.own.seriesRules, []);
    assert(!JSON.stringify(limited).includes(privateTitle));
    assert(!JSON.stringify(limited).includes('PRIVATE CALENDAR'));
    for (const action of ['connect', 'sync', 'disconnect', 'flexibility', 'availability', 'join']) {
      assert.equal((await guest(`${path}/${action}`, { provider: 'manual', name: 'Renamed' })).status, 403, action);
    }
    assert.equal((await guest(`${path}/leave`, undefined, 'DELETE')).status, 403);
    assert.equal((await guest(path, undefined, 'DELETE')).status, 403);
    assert.equal((await guest(`${path}/blocks`, {
      excludedDates: [from], blockedRanges: [{ day: to, start: '16:00', end: '17:00' }], provider: 'manual', tokens: null
    })).status, 200);
    const [stored] = await sql`SELECT data FROM quedem_people WHERE event_code=${code} AND session_hash=${record.session_hash}`;
    assert.equal(stored.data.provider, 'google');
    assert.equal(stored.data.tokens, privateTokens);
    assert.deepEqual(stored.data.seriesRules, [{ id: 'private-series', flexible: true }]);
    assert.deepEqual(stored.data.excludedDates, [from]);
    assert.equal((await get(owner)).own.conflicts[0].title, privateTitle);
    assert.equal((await guest(`${path}/blocks`, { excludedDates: ['1900-01-01'], blockedRanges: [] })).status, 400);
    assert.equal((await guest(`${path}/blocks`, { excludedDates: [], blockedRanges: [{ day: from, start: '16:30', end: '17:00' }] })).status, 400);
    assert.equal((await get(owner)).participants.length, 1);
  });

  await t.test('Google authorization restores private access only for the same account and initiating browser', async () => {
    const recovering = browser(), wrongBrowser = browser();
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        const code = new URLSearchParams(options.body).get('code');
        return Response.json({ access_token: code === 'wrong' ? 'wrong-account' : 'right-account', expires_in: 3600,
          refresh_token: 'integration-refresh', scope: 'https://www.googleapis.com/auth/calendar.events.readonly' });
      }
      if (String(url).startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) {
        const wrong = options.headers.Authorization === 'Bearer wrong-account';
        return Response.json({ items: [
          { id: wrong ? 'wrong@example.test' : 'right@example.test', summary: 'Primary', primary: true },
          { id: 'private-calendar', summary: 'PRIVATE CALENDAR' }
        ] });
      }
      return nativeFetch(url, options);
    };
    try {
      const id = (await get(recovering)).participants[0].id;
      assert.equal((await recovering(`${path}/identify`, { participantId: id })).status, 200);
      const start = async () => {
        const response = await recovering(`${path}/connect`, { provider: 'google' });
        assert.equal(response.status, 200);
        return new URL(response.data.url).searchParams.get('state');
      };
      const stolen = await start();
      assert.equal((await wrongBrowser(`oauth/google/callback?state=${stolen}&code=right`)).status, 403);
      assert.equal((await get(recovering)).own.manualOnly, true);
      const changed = await start();
      await recovering(`${path}/unidentify`, {});
      assert.equal((await recovering(`oauth/google/callback?state=${changed}&code=right`)).status, 403);
      await recovering(`${path}/identify`, { participantId: id });
      const wrong = await start();
      const rejected = await recovering(`oauth/google/callback?state=${wrong}&code=wrong`);
      assert.equal(rejected.status, 303);
      assert(rejected.headers.get('location').endsWith('notice=wrong-account'));
      assert.equal((await get(recovering)).own.manualOnly, true);
      assert.equal((await get(owner)).own.conflicts[0].title, privateTitle);
      const [beforeExpiry] = await sql`SELECT data FROM quedem_people WHERE event_code=${code} AND session_hash=${record.session_hash}`;
      const expiredTokens = encrypt({ access: 'expired-integration-token', expires: 0 });
      await sql`UPDATE quedem_people SET data=jsonb_set(data, '{tokens}', ${JSON.stringify(expiredTokens)}::jsonb)
        WHERE event_code=${code} AND session_hash=${record.session_hash}`;
      try {
        const expired = await start();
        const blocked = await recovering(`oauth/google/callback?state=${expired}&code=right`);
        assert.equal(blocked.status, 303);
        assert(blocked.headers.get('location').endsWith('notice=original-browser'));
        assert.equal((await get(recovering)).own.manualOnly, true);
      } finally {
        await sql`UPDATE quedem_people SET data=${JSON.stringify(beforeExpiry.data)}::jsonb WHERE event_code=${code} AND session_hash=${record.session_hash}`;
      }
      const matching = await start();
      const accepted = await recovering(`oauth/google/callback?state=${matching}&code=right`);
      assert.equal(accepted.status, 303);
      assert(accepted.headers.get('set-cookie').includes(`quedem_edit_${code}=`));
      const restored = await get(recovering);
      assert.equal(restored.own.manualOnly, undefined);
      assert.equal(restored.own.conflicts[0].title, privateTitle);
      assert.deepEqual(restored.own.selected, ['private-calendar']);
      assert.deepEqual(restored.own.excludedDates, [from]);
      assert.deepEqual(restored.own.blockedRanges, [{ day: to, start: '16:00', end: '17:00' }]);
      assert.equal(restored.owner, false);
      assert.equal(restored.participants.length, 1);
      assert.equal((await recovering(`oauth/google/callback?state=${matching}&code=right`)).status, 403);
      const limited = await get(guest);
      assert.equal(limited.own.manualOnly, true);
      assert(!JSON.stringify(limited).includes(privateTitle));
    } finally { globalThis.fetch = nativeFetch; }
  });

  await t.test('manual participants and new registrations can connect Google without duplicating their name', async () => {
    const manualOwner = browser(), recovering = browser();
    assert.equal((await manualOwner(`${path}/join`, { name: 'Manual Google Test' })).status, 200);
    const person = (await get(manualOwner)).editingId;
    await recovering(path);
    await recovering(`${path}/identify`, { participantId: person });
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url) === 'https://oauth2.googleapis.com/token') {
        return Response.json({ access_token: 'manual-google-access', expires_in: 3600 });
      }
      if (String(url).startsWith('https://www.googleapis.com/calendar/v3/users/me/calendarList')) {
        return Response.json({ items: [{ id: 'manual@example.test', summary: 'Manual Google', primary: true }] });
      }
      return nativeFetch(url, options);
    };
    try {
      for (const client of [recovering, manualOwner]) {
        const connection = await client(`${path}/connect`, { provider: 'google' });
        assert.equal(connection.status, 200);
        const state = new URL(connection.data.url).searchParams.get('state');
        const callback = await client(`oauth/google/callback?state=${state}&code=right`);
        assert.equal(callback.status, 303);
        const view = await get(client);
        assert.equal(view.own.provider, 'google');
        assert.equal(view.own.manualOnly, undefined);
        assert.equal(view.own.calendars[0].id, 'manual@example.test');
      }
      assert.equal((await get(recovering)).participants.length, 2);
    } finally {
      globalThis.fetch = nativeFetch;
      assert.equal((await manualOwner(`${path}/leave`, undefined, 'DELETE')).status, 200);
    }
  });

  await t.test('OAuth cancellation belongs to its initiating browser and pending connections can be invalidated', async () => {
    const first = await owner(`${path}/connect`, { provider: 'google' });
    assert.equal(first.status, 200);
    const state = new URL(first.data.url).searchParams.get('state');
    assert.equal((await outsider(`oauth/google/callback?state=${state}&error=access_denied`)).status, 403);
    const ownAttempt = await owner(`${path}/connect`, { provider: 'google' });
    const ownState = new URL(ownAttempt.data.url).searchParams.get('state');
    const cancelled = await owner(`oauth/google/callback?state=${ownState}&error=access_denied`);
    assert.equal(cancelled.status, 303);
    assert.equal(cancelled.headers.get('location'), `/?event=${code}&notice=denied`);
    const pending = await owner(`${path}/connect`, { provider: 'google' });
    assert.equal(pending.status, 200);
  });

  await t.test('disconnect deletes credentials and commitments but preserves exclusions, hourly blocks and participant identity', async () => {
    assert.equal((await owner(`${path}/disconnect`, {}, 'POST', false)).status, 403);
    assert.equal((await owner(`${path}/disconnect`, {})).status, 200);
    const view = await get(owner);
    assert.equal(view.own.provider, 'manual');
    assert.equal(view.own.confirmed, true);
    assert.deepEqual(view.own.excludedDates, [from]);
    assert.deepEqual(view.own.blockedRanges, [{ day: to, start: '16:00', end: '17:00' }]);
    assert.deepEqual(view.own.calendars, []);
    assert.deepEqual(view.own.conflicts, []);
    assert.deepEqual(view.own.seriesRules, []);
    assert.equal(view.own.syncedAt, null);
    assert.equal(view.participants.length, 1);
    assert.equal(view.owner, true);
    const [stored] = await sql`SELECT data FROM quedem_people WHERE event_code=${code} AND session_hash=${record.session_hash}`;
    assert(!('tokens' in stored.data));
    assert.deepEqual(stored.data.busy, []);
    assert.deepEqual(await sql`SELECT state_hash FROM quedem_oauth WHERE event_code=${code}`, []);
    assert.equal((await owner(`${path}/sync`, {})).status, 400);
    assert.equal((await get(guest)).own.manualOnly, true);
  });

  await t.test('selections cannot cross events or bypass legacy privacy; withdrawal clears limited sessions', async () => {
    const otherEvent = await outsider('events', { title: 'Other temporary fixture', type: 'Trobada', from, to, window: 'tarda', duration: 60 });
    assert.equal(otherEvent.status, 201);
    const otherCode = otherEvent.data.code;
    try {
      const id = (await get(owner)).participants[0].id;
      assert.equal((await outsider(`events/${otherCode}/identify`, { participantId: id })).status, 404);
      assert.equal((await outsider(`events/${otherCode}/join`, { name: 'Legacy fixture participant' })).status, 200);
      const legacyView = (await outsider(`events/${otherCode}`)).data;
      await sql`UPDATE quedem_events SET data=jsonb_set(data, '{namedAvailability}', 'false'::jsonb) WHERE code=${otherCode}`;
      assert.equal((await guest(`events/${otherCode}/identify`, { participantId: legacyView.participants[0].id })).status, 403);
    } finally { await sql`DELETE FROM quedem_events WHERE code=${otherCode}`; }
    assert.equal((await guest(`${path}/unidentify`, {})).status, 200);
    assert.equal((await get(guest)).own, null);
    assert.equal((await guest(`${path}/identify`, { participantId: (await get(owner)).participants[0].id })).status, 200);
    assert.equal((await owner(`${path}/leave`, undefined, 'DELETE')).status, 200);
    assert.equal((await get(guest)).own, null);
    assert.equal((await get(owner)).participants.length, 0);
    assert.deepEqual(await sql`SELECT browser_hash FROM quedem_manual_access WHERE event_code=${code}`, []);
  });
});
