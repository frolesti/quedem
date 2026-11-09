import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { validateEvent, candidates, datesFor, rank, validateDates, validateFlexibleConflicts, validateSeriesRules, isFlexible, validateBlockedRanges, blockedPeriod, partialConflicts, attendance, overlaps } from '../lib/schedule.js';
import { encrypt, decrypt, hash, randomToken, requireOrigin } from '../lib/security.js';
import { microsoftBusy, authorization, calendars, googleAccount, busy, conflicts, canReadDetails, refresh } from '../lib/providers.js';
import { ownView, manualView } from '../api/index.js';

const event = { title: 'Trobada', type: 'Sopar', from: '2026-12-01', to: '2026-12-03', window: 'sopar', duration: 120, namedAvailability: true };
const now = DateTime.fromISO('2026-11-05', { zone: 'Europe/Madrid' });
const person = { name: 'Anna', provider: 'manual', confirmed: true, availableDates: ['2026-12-01'], excludedDates: [], busy: [] };

test('Google identity uses exactly one primary calendar, never a shared calendar', () => {
  assert.equal(googleAccount([{ id: 'shared' }, { id: 'owner', primary: true }]), 'owner');
  for (const available of [[], [{ id: 'shared' }], [{ primary: true }], [{ id: 'one', primary: true }, { id: 'two', primary: true }]]) {
    assert.throws(() => googleAccount(available), /principal/);
  }
});

test('validates 60-day search, dates and duration', () => {
  assert.deepEqual(validateEvent(event, now), event);
  for (const update of [{ from: '2026-01-01' }, { to: '2027-03-01' }, { to: '2026-11-01' }, { from: 'nonsense' }, { from: 10 }, { duration: 30 }, { duration: 90 }, { duration: 135 }, { window: 'constructor' }, { window: 'dinar', duration: 240 }, { title: ' ' }]) {
    assert.throws(() => validateEvent({ ...event, ...update }, now));
  }
});
test('creates whole-hour candidates fitting a dinner ending at midnight', () => {
  const slots = candidates(event);
  assert.equal(slots.length, 9);
  assert.equal(slots[0].start, '2026-12-01T19:00:00.000Z');
  assert.equal(slots[2].end, '2026-12-01T23:00:00.000Z');
  assert(slots.every(slot => DateTime.fromISO(slot.start).minute === 0 && DateTime.fromISO(slot.end).minute === 0));
});
test('keeps Madrid local dinner hours through DST', () => {
  const e = { ...event, from: '2027-03-27', to: '2027-03-28' };
  const slots = candidates(e);
  assert.equal(slots[0].start, '2027-03-27T19:00:00.000Z');
  assert.equal(slots[3].start, '2027-03-28T18:00:00.000Z');
});
test('manual availability defaults to free while preserving previously selected dates', () => {
  assert.equal(rank(event, [{ ...person, confirmed: false }], now.toMillis()).length, 9);
  const results = rank(event, [person], now.toMillis());
  assert.equal(results.length, 3);
  assert(results.every(slot => slot.day === '2026-12-01' && slot.all));
});
test('pending people prevent an all-available result', () => {
  assert(rank(event, [person, { ...person, provider: 'google', syncedAt: null }], now.toMillis()).every(slot => !slot.all && slot.total === 2));
});
test('keeps every whole-hour alternative in chronological order regardless of attendance', () => {
  const allDays = { ...person, availableDates: datesFor(event) };
  const connected = { ...person, provider: 'google', syncedAt: now.toISO(), busy: [{ start: '2026-12-01T19:00:00Z', end: '2026-12-01T20:00:00Z' }] };
  const results = rank(event, [allDays, connected], now.toMillis());
  assert.equal(results.length, 9);
  assert.equal(new Set(results.map(slot => slot.day)).size, 3);
  assert.equal(results.filter(slot => slot.all).length, 8);
  assert.equal(results[0].start, '2026-12-01T19:00:00.000Z');
  assert.equal(results[0].available, 1);
  assert.equal(results.at(-1).available, 2);
  assert.deepEqual(results.map(slot => slot.start), results.map(slot => slot.start).sort());
});
test('retains all 60 days and every valid start without a hidden result cutoff', () => {
  const e = { ...event, from: '2026-12-01', to: '2027-01-29', window: 'tarda', duration: 60 };
  const results = rank(e, [{ ...person, availableDates: datesFor(e) }], now.toMillis());
  assert.equal(results.length, 240);
  assert.equal(new Set(results.map(slot => slot.day)).size, 60);
});
test('three independent calendars produce different full-group hours and partial alternatives', () => {
  const e = { ...event, window: 'tarda', duration: 60 };
  const connected = (name, busy) => ({ ...person, name, provider: 'google', syncedAt: now.toISO(), busy });
  const results = rank(e, [
    connected('Anna', [{ start: '2026-12-01T15:00Z', end: '2026-12-01T16:00Z' }]),
    connected('Biel', [{ start: '2026-12-01T17:00Z', end: '2026-12-01T19:00Z' }]),
    connected('Carla', [{ start: '2026-12-02T15:00Z', end: '2026-12-02T17:00Z' }])
  ], now.toMillis());
  assert.deepEqual(results.filter(slot => slot.day === '2026-12-01' && slot.all).map(slot => slot.start), ['2026-12-01T16:00:00.000Z']);
  assert.deepEqual(results.filter(slot => slot.day === '2026-12-02' && slot.all).map(slot => slot.start), ['2026-12-02T17:00:00.000Z', '2026-12-02T18:00:00.000Z']);
  assert(results.some(slot => slot.available === 2 && slot.total === 3 && !slot.all));
});
test('calendar connections without any valid saved snapshot are not treated as free', () => {
  for (const syncedAt of [null, 'invalid']) {
    assert.equal(rank(event, [{ ...person, provider: 'google', syncedAt }], now.toMillis()).length, 0);
  }
});
test('saved calendar availability never expires and keeps conflicts, manual blocks and flexibility', () => {
  for (const provider of ['google', 'microsoft']) {
    const saved = {
      ...person, provider, syncedAt: now.minus({ days: 365 }).toISO(),
      busy: [
        { id: 'blocked', start: '2026-12-01T19:00Z', end: '2026-12-01T20:00Z' },
        { id: 'flexible', start: '2026-12-03T19:00Z', end: '2026-12-03T23:00Z' }
      ],
      flexibleConflicts: ['flexible'], excludedDates: ['2026-12-02'],
      blockedRanges: [{ day: '2026-12-03', start: '22:00', end: '23:00' }]
    };
    const results = rank(event, [saved], now.toMillis());
    assert.deepEqual(results, rank(event, [{ ...saved, syncedAt: now.toISO() }], now.toMillis()));
    assert(results.length > 0);
    assert(results.every(slot => slot.checked === 1 && slot.all));
    assert(!results.some(slot => slot.day === '2026-12-02'));
    assert(!results.some(slot => slot.start === '2026-12-01T19:00:00.000Z'));
    assert(results.some(slot => slot.start === '2026-12-03T19:00:00.000Z'));
    assert(!results.some(slot => slot.start === '2026-12-03T21:00:00.000Z'));
  }
});
test('busy conflicts, manual exceptions and counts are respected', () => {
  const connected = { ...person, provider: 'microsoft', syncedAt: now.toISO(), busy: [{ start: '2026-12-01T19:00:00Z', end: '2026-12-01T23:00:00Z' }], excludedDates: ['2026-12-02'] };
  const results = rank(event, [person, connected], now.toMillis());
  assert(results.every(slot => slot.available === 1 && !slot.all));
  assert.equal(rank(event, [{ ...person, excludedDates: ['2026-12-01'] }], now.toMillis()).length, 0);
});
test('adjacent events are not a conflict', () => {
  assert.equal(overlaps({ start: '2026-12-01T19:00Z', end: '2026-12-01T20:00Z' }, { start: '2026-12-01T20:00Z', end: '2026-12-01T21:00Z' }), false);
});
test('named attendance matches counts, distinguishes pending and preserves legacy privacy', () => {
  const pending = { ...person, name: 'Pending', provider: 'google', syncedAt: null };
  const unavailable = { ...person, name: 'Unavailable', availableDates: [] };
  const [slot] = rank(event, [person, unavailable, pending], now.toMillis());
  assert.deepEqual(slot.attendance, [{ name: 'Anna', status: 'available' }, { name: 'Unavailable', status: 'unavailable' }, { name: 'Pending', status: 'pending' }]);
  assert.equal(slot.available, slot.attendance.filter(p => p.status === 'available').length);
  assert(!('attendance' in rank({ ...event, namedAvailability: undefined }, [person], now.toMillis())[0]));
  assert(slot.attendance.every(p => Object.keys(p).length === 2));
});
test('flexibility ignores only chosen current conflicts and never overrides exclusions or other overlaps', () => {
  const periods = [{ id: 'a', start: '2026-12-01T19:00Z', end: '2026-12-01T23:00Z' }];
  const connected = { ...person, provider: 'google', syncedAt: now.toISO(), busy: periods };
  assert.equal(rank(event, [connected], now.toMillis()).filter(s => s.day === '2026-12-01').length, 0);
  const flexible = { ...connected, flexibleConflicts: ['a'] };
  assert.equal(rank(event, [flexible], now.toMillis()).filter(s => s.day === '2026-12-01').length, 3);
  assert.equal(rank(event, [{ ...flexible, excludedDates: ['2026-12-01'] }], now.toMillis()).filter(s => s.day === '2026-12-01').length, 0);
  assert.equal(rank(event, [{ ...flexible, busy: [...periods, { ...periods[0], id: 'b' }] }], now.toMillis()).filter(s => s.day === '2026-12-01').length, 0);
  assert.deepEqual(validateFlexibleConflicts(['a','a'], connected), ['a']);
  assert.throws(() => validateFlexibleConflicts(['foreign'], connected));
  assert.throws(() => validateFlexibleConflicts('a', connected));
  assert.throws(() => validateFlexibleConflicts(Array(101).fill('a'), connected));
});
test('private conflict titles are encrypted and returned only in the own view', () => {
  process.env.APP_SECRET = 'test-key-only-never-production-0123456789';
  const details = [{ id: 'x', title: 'PRIVATE TITLE', start: '2026-12-01T19:00Z', end: '2026-12-01T20:00Z' }];
  const data = { ...person, conflicts: encrypt(details), flexibleConflicts: ['x'] };
  assert(!data.conflicts.includes('PRIVATE TITLE'));
  assert.deepEqual(ownView(data).conflicts, details);
  assert(!JSON.stringify(rank(event, [data], now.toMillis())).includes('PRIVATE TITLE'));
});
test('hourly blocks validate, deduplicate and merge without accepting foreign dates or half hours', () => {
  const range = { day: event.from, start: '20:00', end: '21:00' };
  assert.deepEqual(validateBlockedRanges([range, range, { ...range, start: '21:00', end: '23:00' }], event),
    [{ ...range, end: '23:00' }]);
  for (const invalid of [null, {}, [null], [{ ...range, day: '2026-12-04' }], [{ ...range, start: '20:30' }],
    [{ ...range, start: ['20:00'] }], [{ ...range, start: '19:00' }], [{ ...range, end: '25:00' }],
    [{ ...range, end: '20:00' }], Array(241).fill(range)]) {
    assert.throws(() => validateBlockedRanges(invalid, event));
  }
  assert.equal(validateBlockedRanges(Array(240).fill(range), event).length, 1);
});
test('hourly manual blocks affect only overlapping proposals for manual and connected participants', () => {
  const e = { ...event, window: 'tarda', duration: 60 };
  const blockedRanges = [{ day: event.from, start: '17:00', end: '18:00' }];
  for (const provider of ['manual', 'google', 'microsoft']) {
    const p = { ...person, provider, syncedAt: now.toISO(), blockedRanges, flexibleConflicts: ['flex'],
      busy: [{ id: 'flex', start: '2026-12-01T15:00Z', end: '2026-12-01T19:00Z' }] };
    const results = candidates(e).filter(slot => slot.day === event.from).map(slot => attendance(p, slot, now.toMillis()));
    assert.deepEqual(results, ['available', 'unavailable', 'available', 'available']);
  }
  const p = { ...person, blockedRanges, excludedDates: [event.from] };
  assert(candidates(e).filter(slot => slot.day === event.from).every(slot => attendance(p, slot, now.toMillis()) === 'unavailable'));
  assert(candidates(e).filter(slot => slot.day === event.from).every(slot => attendance({ ...p, confirmed: false }, slot, now.toMillis()) === 'unavailable'));
});
test('hourly blocks respect full meeting duration, midnight and Madrid DST', () => {
  const blockedRanges = [{ day: event.from, start: '21:00', end: '22:00' }];
  const statuses = candidates(event).slice(0, 3).map(slot => attendance({ ...person, blockedRanges }, slot, now.toMillis()));
  assert.deepEqual(statuses, ['unavailable', 'unavailable', 'available']);
  assert.deepEqual(blockedPeriod({ day: event.from, start: '23:00', end: '24:00' }),
    { start: '2026-12-01T22:00:00.000Z', end: '2026-12-01T23:00:00.000Z' });
  assert.equal(blockedPeriod({ day: '2027-03-28', start: '20:00', end: '21:00' }).start, '2027-03-28T18:00:00.000Z');
});
test('partial calendar overlaps ask explicitly, remain blocked until yes and remember no', () => {
  const e = { ...event, window: 'tarda', duration: 60 };
  const busy = [{ id: 'half', start: '2026-12-01T15:30Z', end: '2026-12-01T17:00Z' }];
  const p = { ...person, provider: 'google', syncedAt: now.toISO(), busy };
  assert.deepEqual(partialConflicts(e, p, now.toMillis()), [
    { id: 'half', start: '2026-12-01T15:00:00.000Z', end: '2026-12-01T16:00:00.000Z' }
  ]);
  const no = { ...p, reviewedConflicts: ['half'] };
  assert.deepEqual(partialConflicts(e, no, now.toMillis()), []);
  assert.equal(attendance(no, candidates(e)[0], now.toMillis()), 'unavailable');
  const yes = { ...p, flexibleConflicts: ['half'] };
  assert.deepEqual(partialConflicts(e, yes, now.toMillis()), []);
  assert(candidates(e).slice(0, 4).every(slot => attendance(yes, slot, now.toMillis()) === 'available'));
  assert.deepEqual(partialConflicts(e, { ...p, busy: [{ ...busy[0], start: '2026-12-01T15:00Z' }] }, now.toMillis()), []);
  assert.deepEqual(p.busy, busy);
});
test('manual participants need no all-free confirmation and explicit existing exclusions stay blocked', () => {
  const e = { ...event, window: 'tarda', duration: 60 };
  assert(candidates(e).every(slot => attendance({ ...person, confirmed: false, availableDates: [], blockedRanges: [] }, slot, now.toMillis()) === 'available'));
  assert(candidates(e).every(slot => attendance({ ...person, availableDates: datesFor(e) }, slot, now.toMillis()) === 'available'));
  assert(candidates(e).filter(slot => slot.day !== event.from).every(slot => attendance(person, slot, now.toMillis()) === 'unavailable'));
});

test('name-only group view exposes manual blocks but never decrypts or returns private calendar data', () => {
  const data = {
    ...person, provider: 'google', calendars: [{ id: 'secret', name: 'PRIVATE CALENDAR' }],
    selected: ['secret'], tokens: 'PRIVATE TOKEN', conflicts: 'not-even-valid-ciphertext',
    busy: [{ id: 'private', start: 'private', end: 'private' }],
    seriesRules: [{ id: 'private-series', flexible: true }], flexibleConflicts: ['private'],
    blockedRanges: [{ day: event.from, start: '20:00', end: '21:00' }]
  };
  const view = manualView(data);
  assert.equal(view.manualOnly, true);
  assert.deepEqual(view.blockedRanges, data.blockedRanges);
  assert.deepEqual(view.calendars, []);
  assert.deepEqual(view.conflicts, []);
  assert.deepEqual(view.seriesRules, []);
  assert(!('tokens' in view));
  assert(!('busy' in view));
  assert(!JSON.stringify(view).includes('PRIVATE'));
});
test('series rules affect existing and newly discovered instances but never similarly named unrelated events', () => {
  const first = { id: 'one', seriesId: 'series-a', start: '2026-12-01T19:00Z', end: '2026-12-01T20:00Z' };
  const next = { ...first, id: 'two', start: '2026-12-02T19:00Z', end: '2026-12-02T20:00Z' };
  const p = { ...person, provider: 'google', syncedAt: now.toISO(), busy: [first, next], seriesRules: [{ id: 'series-a', flexible: true }] };
  assert(isFlexible(p, first));
  assert(isFlexible(p, { ...first, id: 'new-instance' }));
  assert(!isFlexible(p, { ...first, id: 'unrelated', seriesId: 'series-b' }));
  assert(!isFlexible(p, { ...first, id: 'standalone', seriesId: undefined }));
  assert.equal(rank(event, [p], now.toMillis()).length, 9);
  const blocking = { ...p, seriesRules: [{ id: 'series-a', flexible: false }] };
  assert(!isFlexible(blocking, first));
  assert.equal(rank(event, [blocking], now.toMillis()).length, 7);
  assert.deepEqual(p.busy, [first, next]);
});
test('individual decisions override a series without changing other sessions or overriding manual blocks', () => {
  const period = { id: 'one', seriesId: 's', start: '2026-12-01T19:30Z', end: '2026-12-01T20:00Z' };
  const p = { ...person, provider: 'google', syncedAt: now.toISO(), busy: [period], seriesRules: [{ id: 's', flexible: true }], reviewedConflicts: ['one'] };
  assert(!isFlexible(p, period));
  assert(isFlexible(p, { ...period, id: 'new' }));
  assert(isFlexible({ ...p, flexibleConflicts: ['one'], seriesRules: [{ id: 's', flexible: false }] }, period));
  assert.equal(rank(event, [{ ...p, reviewedConflicts: [], excludedDates: [event.from] }], now.toMillis()).filter(slot => slot.day === event.from).length, 0);
  assert.deepEqual(partialConflicts(event, { ...p, reviewedConflicts: [] }, now.toMillis()), []);
  assert.deepEqual(partialConflicts(event, { ...p, seriesRules: [{ id: 's', flexible: false }] }, now.toMillis()), []);
  const view = ownView({ ...p, reviewedConflicts: [] }, event);
  assert.deepEqual(view.effectiveFlexibleConflicts, ['one']);
  const shared = JSON.stringify(rank(event, [p], now.toMillis()));
  assert(!shared.includes('seriesRules') && !shared.includes('seriesId'));
});
test('series policies reject unknown series, malformed rules, duplicates and over-limit input', () => {
  const p = { ...person, busy: [{ id: 'one', seriesId: 's' }] };
  assert.deepEqual(validateSeriesRules([{ id: 's', flexible: false, extra: 'ignored' }], p), [{ id: 's', flexible: false }]);
  for (const invalid of [null, {}, [null], [{ id: 'foreign', flexible: true }], [{ id: 's', flexible: 'true' }],
    [{ id: 's', flexible: true }, { id: 's', flexible: false }], Array(101).fill({ id: 's', flexible: true })]) {
    assert.throws(() => validateSeriesRules(invalid, p));
  }
});
test('rejects dates outside the event and deduplicates valid dates', () => {
  assert.equal(datesFor(event).length, 3);
  assert.throws(() => validateDates(['2026-12-04'], event));
  assert.throws(() => validateDates('2026-12-01', event));
  assert.deepEqual(validateDates(['2026-12-01', '2026-12-01'], event), ['2026-12-01']);
});
test('excludes elapsed slots', () => {
  assert.equal(rank(event, [person], DateTime.fromISO('2027-01-01').toMillis()).length, 0);
});
test('tokens are authenticated and encrypted, not exposed in own response', () => {
  process.env.APP_SECRET = 'test-key-only-never-production-0123456789';
  const secret = { access: randomToken(), refresh: randomToken() };
  const encrypted = encrypt(secret);
  assert.deepEqual(decrypt(encrypted), secret);
  const bytes = Buffer.from(encrypted, 'base64url'); bytes[bytes.length - 1] ^= 1;
  assert.throws(() => decrypt(bytes.toString('base64url')));
  assert(!encrypted.includes(secret.access));
  const response = ownView({ ...person, tokens: encrypted, busy: [{ private: true }] });
  assert(!('tokens' in response)); assert(!('busy' in response));
  assert.equal(hash(randomToken()).length, 64);
});
test('mutations reject missing and third-party Origin', () => {
  process.env.APP_URL = 'https://quedem.example';
  assert.throws(() => requireOrigin({ headers: {} }));
  assert.throws(() => requireOrigin({ headers: { origin: 'https://attacker.example' } }));
  requireOrigin({ headers: { origin: 'https://quedem.example' } });
});
test('Microsoft ignores cancelled and free events, includes busy and tentative', () => {
  const e = { start: { dateTime: '2026-12-01T19:00:00' }, end: { dateTime: '2026-12-01T21:00:00' }, showAs: 'busy', isCancelled: false };
  const result = microsoftBusy([e, { ...e, showAs: 'free' }, { ...e, isCancelled: true }, { ...e, showAs: 'tentative' }]);
  assert.equal(result.length, 2);
  assert.equal(result[0].start, '2026-12-01T19:00:00.000Z');
  assert.throws(() => microsoftBusy([{ ...e, start: {} }]));
});
test('OAuth carries PKCE, state, callback and least-privilege scopes', () => {
  for (const provider of ['google', 'microsoft']) {
    process.env[`${provider.toUpperCase()}_CLIENT_ID`] = 'test-client';
    process.env[`${provider.toUpperCase()}_CLIENT_SECRET`] = 'test-secret';
    const url = new URL(authorization(provider, 'state', 'verifier'));
    assert.equal(url.searchParams.get('state'), 'state');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('redirect_uri'), `https://quedem.example/api/oauth/${provider}/callback`);
    assert(!url.searchParams.get('scope').includes('ReadWrite'));
    if (provider === 'microsoft') assert(url.searchParams.get('scope').includes('Calendars.ReadBasic'));
    if (provider === 'google') assert(url.searchParams.get('scope').includes('calendar.events.readonly'));
  }
});
test('Google conflict details handle recurring instances, all-day time zones, pagination and transparent events', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async url => {
    calls.push(url);
    if (new URL(url).searchParams.has('pageToken')) return Response.json({ items: [{ id: 'all-day', summary: 'Holiday', start: { date: '2026-12-02' }, end: { date: '2026-12-03' } }] });
    const item = { id: 'instance', recurringEventId: 'master', summary: 'Private task', start: { dateTime: '2026-12-01T20:00:00+01:00' }, end: { dateTime: '2026-12-01T21:00:00+01:00' } };
    return Response.json({ items: [item, { ...item, id: 'free', transparency: 'transparent' }, { ...item, id: 'cancelled', status: 'cancelled' }], nextPageToken: 'next' });
  };
  try {
    const result = await conflicts('google','token',['a'],event,[{ id: 'a', timeZone: 'America/New_York' }]);
    assert.equal(result.length, 2);
    assert.equal(result[0].title, 'Private task');
    assert.equal(result[0].start, '2026-12-01T19:00:00.000Z');
    assert.equal(result[1].start, '2026-12-02T05:00:00.000Z');
    assert.equal(new URL(calls[0]).searchParams.get('singleEvents'), 'true');
    assert.equal(result[0].id.length, 64);
    assert.equal(result[0].seriesId.length, 64);
    assert(!result[1].seriesId);
    const again = await conflicts('google','token',['a'],event,[{ id:'a', timeZone:'America/New_York' }]);
    assert.equal(again[0].id, result[0].id);
    assert.equal(again[0].seriesId, result[0].seriesId);
    const otherCalendar = await conflicts('google','token',['b'],event,[]);
    assert.notEqual(otherCalendar[0].seriesId, result[0].seriesId);
  } finally { global.fetch = original; }
});
test('Google conflict lookup never treats a failed calendar or invalid event as free', async () => {
  const original = global.fetch;
  try {
    global.fetch = async () => Response.json({}, { status: 403 });
    await assert.rejects(() => conflicts('google','token',['a'],event,[]), /rebutjat/);
    global.fetch = async () => Response.json({ items: [{ id:'x', start:{},end:{} }] });
    await assert.rejects(() => conflicts('google','token',['a'],event,[]), /incomplet/);
  } finally { global.fetch = original; }
});
test('Outlook conflict details request only read-only summary and occupancy fields', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async url => {
    calls.push(url);
    const item = { id:'instance', seriesMasterId:'master', subject:'Private meeting', start:{dateTime:'2026-12-01T19:00:00'}, end:{dateTime:'2026-12-01T20:00:00'}, showAs:'busy' };
    return Response.json({value:[item,{...item,id:'free',showAs:'free'},{...item,id:'cancelled',isCancelled:true}]});
  };
  try {
    const result = await conflicts('microsoft','token',['a'],event,[]);
    assert.equal(result.length, 1);
    assert.equal(result[0].title, 'Private meeting');
    assert.equal(result[0].start, '2026-12-01T19:00:00.000Z');
    assert.equal(new URL(calls[0]).searchParams.get('$select'), 'id,subject,start,end,showAs,isCancelled,seriesMasterId');
    assert.equal(result[0].id.length,64);
    assert.equal(result[0].seriesId.length,64);
  } finally { global.fetch = original; }
});
test('old Google authorizations retain freebusy support without silently upgrading scopes on refresh', async () => {
  assert.equal(canReadDetails('google',{}), false);
  assert.equal(canReadDetails('google',{scope:'https://www.googleapis.com/auth/calendar.events.freebusy'}), false);
  assert.equal(canReadDetails('google',{scope:'https://www.googleapis.com/auth/calendar.events.readonly'}), true);
  const original = global.fetch;
  global.fetch = async () => Response.json({access_token:'next',expires_in:3600});
  try {
    const tokens = await refresh('google',{access:'old',refresh:'refresh',expires:0,scope:'https://www.googleapis.com/auth/calendar.events.freebusy'});
    assert.equal(canReadDetails('google', tokens), false);
  } finally { global.fetch = original; }
});
test('Microsoft pagination and recurrence instances retain only occupancy fields', async () => {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (url, options) => {
    calls.push([url, options]);
    if (url.includes('page=2')) return Response.json({ value: [{ id: 'b', name: 'Personal' }] });
    if (url.includes('/me/calendars?')) return Response.json({ value: [{ id: 'a', name: 'Feina' }], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars?page=2' });
    return Response.json({ value: [{ start: { dateTime: '2026-12-01T19:00:00' }, end: { dateTime: '2026-12-01T20:00:00' }, showAs: 'busy' }] });
  };
  try {
    assert.equal((await calendars('microsoft', 'token')).length, 2);
    assert.equal((await busy('microsoft', 'token', ['a'], event)).length, 1);
    assert(calls.at(-1)[0].includes('calendarView'));
    assert.equal(new URL(calls.at(-1)[0]).searchParams.get('$select'), 'start,end,showAs,isCancelled');
  } finally { global.fetch = original; }
});
test('Google per-calendar failures do not become empty/free calendars', async () => {
  const original = global.fetch;
  global.fetch = async () => Response.json({ calendars: { a: { errors: [{ reason: 'notFound' }] } } });
  try { await assert.rejects(() => busy('google', 'token', ['a'], event), /No s’ha pogut consultar/); }
  finally { global.fetch = original; }
});
test('pagination cannot send a bearer token to another host', async () => {
  const original = global.fetch;
  let count = 0;
  global.fetch = async () => { count++; return Response.json({ value: [], '@odata.nextLink': 'https://attacker.example/steal' }); };
  try {
    await assert.rejects(() => calendars('microsoft', 'token'), /límits/);
    assert.equal(count, 1);
  } finally { global.fetch = original; }
});
