import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

function ui({
  location = { origin: 'https://quedem.test', href: 'https://quedem.test/', pathname: '/', search: '', hash: '' },
  history = { replaceState() {} }
} = {}) {
  const nodes = new Map();
  const element = () => ({
    textContent: '', hidden: false, disabled: false, value: '', dataset: {}, children: [], listeners: {},
    addEventListener(type, listener) { this.listeners[type] = listener; },
    setCustomValidity(value) { this.validationMessage = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    querySelectorAll(selector) {
      return this.children.flatMap(child => [
        ...(child.className?.split(' ').includes(selector.slice(1)) ? [child] : []),
        ...child.querySelectorAll(selector)
      ]);
    },
    setAttribute(name, value) { this[name] = value; }
  });
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, element());
    return nodes.get(id);
  };
  const elements = {
    from: { value: '2026-11-06' }, to: { value: '2026-11-20' },
    window: { value: 'tarda' }, duration: { selectedOptions: [{ textContent: '4 hores' }] }
  };
  node('create-form').elements = elements;
  const context = vm.createContext({
    document: { getElementById: node, createElement: element },
    // Keep bootstrap pending: each test drives the actual UI functions explicitly.
    fetch: () => new Promise(() => {}),
    URL, URLSearchParams,
    location, history,
    setTimeout, clearTimeout
  });
  vm.runInContext(source, context);
  vm.runInContext("settings = { windows: { tarda: { label: 'Tarda', start: '16:00', end: '20:00' } } };", context);
  return { node, elements, evaluate: code => vm.runInContext(code, context) };
}

test('moving the first date forward moves the last date and its valid bounds', () => {
  const { elements, evaluate } = ui();
  elements.from.value = '2026-12-14';
  evaluate('updateDateRange({ target: $("create-form").elements.from });');
  assert.equal(elements.to.value, '2026-12-28');
  assert.equal(elements.to.min, '2026-12-14');
  assert.equal(elements.to.max, '2027-02-11');
});

test('date changes preserve a valid end and never leave more than 60 inclusive days', () => {
  const { elements, evaluate, node } = ui();
  elements.from.value = '2026-12-14';
  elements.to.value = '2026-12-20';
  evaluate('updateDateRange({ target: $("create-form").elements.to });');
  elements.from.value = '2026-12-15';
  evaluate('updateDateRange({ target: $("create-form").elements.from });');
  assert.equal(elements.to.value, '2026-12-20');
  elements.to.value = '2027-12-31';
  evaluate('updateDateRange({ target: $("create-form").elements.to });');
  assert.equal(elements.to.value, '2027-02-12');
  assert(node('plan-summary').textContent.includes('4 hores'));
  assert(!node('plan-summary').textContent.includes('minuts'));
});

test('automatic end dates retain a chosen span across month and year boundaries', () => {
  const { elements, evaluate } = ui();
  elements.from.value = '2026-12-14'; elements.to.value = '2026-12-17';
  evaluate('updateDateRange({ target: $("create-form").elements.to });');
  elements.from.value = '2026-12-30';
  evaluate('updateDateRange({ target: $("create-form").elements.from });');
  assert.equal(elements.to.value, '2027-01-02');
  elements.from.value = '2027-02-27';
  evaluate('updateDateRange({ target: $("create-form").elements.from });');
  assert.equal(elements.to.value, '2027-03-02');
});

test('duration labels use hours while preserving legacy half-hour durations', () => {
  const { evaluate } = ui();
  for (const [value, label] of [[60, '1 hora'], [120, '2 hores'], [180, '3 hores'], [240, '4 hores'],
    [30, 'Mitja hora'], [90, '1 hora i mitja'], [150, '2 hores i mitja']]) {
    assert.equal(evaluate(`durationLabel(${value})`), label);
  }
});

test('all visible dates use dd/mm/yyyy independently of browser locale', () => {
  const { node, evaluate } = ui();
  evaluate('updateDateInputs();');
  assert.equal(node('display-from').value, '06/11/2026');
  assert.equal(node('display-to').value, '20/11/2026');
  assert.equal(evaluate("dateLabel('2027-01-02')"), '02/01/2027');
  assert.equal(evaluate("instant('2027-01-02T18:00:00Z')"), '02/01/2027, 19:00');
});

test('typed dates validate calendar dates, retain ISO payloads and advance the end date', () => {
  const { node, elements, evaluate } = ui();
  node('display-from').dataset = { date: 'from' };
  node('display-to').dataset = { date: 'to' };
  elements.from.min = '2026-11-06'; elements.from.max = '2027-11-06';
  node('display-from').value = '14/12/2026';
  evaluate('readDateInput($("display-from"));');
  assert.equal(elements.from.value, '2026-12-14');
  assert.equal(elements.to.value, '2026-12-28');
  assert.equal(node('display-to').value, '28/12/2026');
  for (const invalid of ['31/02/2027', '11/20/2026', '1/2/2027', '29/02/2027']) {
    node('display-to').value = invalid;
    evaluate('readDateInput($("display-to"));');
    assert(node('display-to').validationMessage);
    assert.equal(elements.to.value, '');
  }
  node('display-from').value = '05/11/2026';
  evaluate('readDateInput($("display-from"));');
  assert(node('display-from').validationMessage);
  node('display-from').value = '28/02/2027';
  evaluate('readDateInput($("display-from"));');
  assert.equal(node('display-from').validationMessage, '');
});

test('identity selector stays available for guests, selected names and private participants', () => {
  const { node, evaluate } = ui();
  evaluate(`event = { namedAvailability: true, participants: [{ id: 'one', name: 'Joan' }, { id: 'two', name: 'Anna' }], own: null }; renderIdentity();`);
  assert.equal(node('identify').hidden, false);
  assert.equal(node('join').hidden, false);
  assert.equal(node('existing-person').children[0].textContent, 'No hi soc: afegir-me');
  evaluate(`event.own = { manualOnly: true }; event.editingId = 'two'; renderIdentity();`);
  assert.equal(node('identify').hidden, false);
  assert.equal(node('join').hidden, true);
  assert.equal(node('existing-person').value, 'two');
  evaluate(`event.own = null; event.editingId = null; renderIdentity();`);
  assert.equal(node('join').hidden, false);
  evaluate(`event.own = { name: 'Joan' }; event.editingId = 'one'; event.privateParticipantId = 'one'; renderIdentity();`);
  assert.equal(node('identify').hidden, false);
  assert.equal(node('existing-person').value, 'one');
  assert.equal(node('existing-person').children[0].textContent, 'Tornar a la meva participació');
});

test('closing a saved date dialog clears the selection synchronously, without a close event', () => {
  const { evaluate, node } = ui();
  let closed = false;
  node('block-dialog').close = () => {
    assert(node('edit-days').hidden);
    assert(node('edit-days').disabled);
    closed = true;
  };
  evaluate("selectedDays = new Set(['2027-01-13']); updateDaySelection();");
  assert(!node('edit-days').hidden);
  evaluate('closeDayDialog();');
  assert(closed);
  assert.equal(evaluate('selectedDays.size'), 0);
});

test('bootstrap consumes OAuth messages and removes legacy secrets before network requests complete', () => {
  const token = 'a'.repeat(43);
  const search = '?event=ABCDEF12345678&notice=connected';
  let cleaned;
  ui({
    location: { origin: 'https://quedem.test', href: `https://quedem.test/${search}#edit=${token}`, pathname: '/', search, hash: `#edit=${token}` },
    history: { replaceState(_state, _title, url) { cleaned = url; } }
  });
  assert.equal(cleaned, '/?event=ABCDEF12345678');
  assert(!cleaned.includes(token));
  assert(!cleaned.includes('notice'));
});

test('calendar selection can be hidden and its collapsed state survives availability rerenders', () => {
  const { node, evaluate } = ui();
  evaluate("event = { code: 'ABCDEF12345678', editingId: 'person-one', own: { provider: 'google', selected: ['calendar-one'] } }; renderCalendarPanel();");
  assert.equal(node('calendar-menu').open, false);
  assert.equal(node('calendar-count').textContent, '1 calendari seleccionat');
  evaluate('$("calendar-menu").open = true; renderCalendarPanel();');
  assert.equal(node('calendar-menu').open, true);
  evaluate('$("calendar-menu").open = false; renderCalendarPanel(); renderCalendarPanel();');
  assert.equal(node('calendar-menu').open, false);
  evaluate("event.own.selected = []; event.own.provider = 'microsoft'; renderCalendarPanel();");
  assert.equal(node('calendar-menu').open, true);
  assert.equal(node('calendar-count').textContent, 'Tria els calendaris');
  evaluate("event.own.selected = ['one', 'two']; renderCalendarPanel();");
  assert.equal(node('calendar-count').textContent, '2 calendaris seleccionats');
});

test('provider buttons show disconnect only for the connected provider', () => {
  const { node, evaluate } = ui();
  evaluate("event = { own: { provider: 'google' } }; renderConnections();");
  assert.equal(node('google').textContent, 'Desconnectar Google Calendar');
  assert.equal(node('microsoft').textContent, 'Connectar Outlook');
  evaluate("event.own.provider = 'manual'; renderConnections();");
  assert.equal(node('google').textContent, 'Connectar Google Calendar');
});

test('Google connection remains visible for selected names without offering to disconnect someone else', () => {
  const { node, evaluate } = ui();
  evaluate("event = { own: { provider: 'google', manualOnly: true } }; renderConnections();");
  assert.equal(node('connections').hidden, false);
  assert.equal(node('google').textContent, 'Connectar Google Calendar');
  assert.equal(node('reconnect-google').hidden, true);
  evaluate("event.own.manualOnly = false; failedSync = true; renderConnections();");
  assert.equal(node('google').textContent, 'Desconnectar Google Calendar');
  assert.equal(node('reconnect-google').hidden, false);
});

test('errors remain explicit and closeable without a persistent banner', () => {
  const { node, evaluate } = ui();
  node('error-dialog').showModal = () => { node('error-dialog').open = true; };
  evaluate("showError('No s’ha pogut desar.');");
  assert.equal(node('error-message').textContent, 'No s’ha pogut desar.');
  assert.equal(node('error-dialog').open, true);
  node('block-dialog').open = true;
  evaluate("showError('Revisa la franja.');");
  assert.equal(node('block-error').textContent, 'Revisa la franja.');
});
test('name-only editing saves only manual blocks, never calendar or flexibility preferences', async () => {
  const { evaluate } = ui();
  const result = await evaluate(`
    event = { own: { manualOnly: true } };
    saveChange = (action, data) => ({ action, data });
    saveAvailability(new Set(['2026-12-14']), [{ day: '2026-12-15', start: '18:00', end: '19:00' }]);
  `);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), {
    action: 'blocks',
    data: { excludedDates: ['2026-12-14'], blockedRanges: [{ day: '2026-12-15', start: '18:00', end: '19:00' }] }
  });

});

test('one result filter hides only days without any full-group slot and preserves chronological order', () => {
  const { evaluate, node } = ui();
  const sections = [
    { dataset: { full: 'false' }, hidden: false },
    { dataset: { full: 'true' }, hidden: false },
    { dataset: { full: 'false' }, hidden: false },
    { dataset: { full: 'true' }, hidden: false }
  ];
  node('results').querySelectorAll = () => sections;
  evaluate('updateResultFilter();');
  assert.equal(node('toggle-partial-days').hidden, false);
  assert.equal(node('toggle-partial-days').textContent, 'Amagar 2 dies sense coincidència completa');
  evaluate('showPartialDays = false; updateResultFilter();');
  assert.deepEqual(sections.map(section => section.hidden), [true, false, true, false]);
  assert.equal(node('toggle-partial-days')['aria-expanded'], 'false');
  assert.equal(node('filtered-empty').hidden, true);
  evaluate('updateResultFilter();');
  assert.deepEqual(sections.map(section => section.hidden), [true, false, true, false]);
  evaluate('showPartialDays = true; updateResultFilter();');
  assert(sections.every(section => !section.hidden));
});

test('filter stays recoverable when every day is partial and disappears when no partial days exist', () => {
  const { evaluate, node } = ui();
  let sections = [{ dataset: { full: 'false' }, hidden: false }];
  node('results').querySelectorAll = () => sections;
  evaluate('showPartialDays = false; updateResultFilter();');
  assert.equal(node('filtered-empty').hidden, false);
  assert.equal(node('toggle-partial-days').hidden, false);
  assert.equal(node('toggle-partial-days').textContent, 'Mostrar 1 dia sense coincidència completa');
  sections = [{ dataset: { full: 'true' }, hidden: false }];
  evaluate('updateResultFilter();');
  assert.equal(node('filtered-empty').hidden, true);
  assert.equal(node('toggle-partial-days').hidden, true);
  assert.equal(sections[0].hidden, false);
  sections = [];
  evaluate('updateResultFilter();');
  assert.equal(node('filtered-empty').hidden, true);
  assert.equal(node('toggle-partial-days').hidden, true);
});

const resultFixtures = [
  { day: '2026-12-01', start: '2026-12-01T18:00:00Z', end: '2026-12-01T19:00:00Z', available: 2, total: 13, all: false },
  { day: '2026-12-04', start: '2026-12-04T18:00:00Z', end: '2026-12-04T19:00:00Z', available: 10, total: 13, all: false },
  { day: '2026-12-02', start: '2026-12-02T18:00:00Z', end: '2026-12-02T19:00:00Z', available: 13, total: 13, all: true },
  { day: '2026-12-03', start: '2026-12-03T18:00:00Z', end: '2026-12-03T19:00:00Z', available: 10, total: 13, all: false },
  { day: '2026-12-01', start: '2026-12-01T16:00:00Z', end: '2026-12-01T17:00:00Z', available: 1, total: 13, all: false }
];

test('availability sorting uses each day’s best slot, numeric counts and chronological ties', () => {
  const { evaluate } = ui();
  evaluate(`event = { proposals: ${JSON.stringify(resultFixtures)} };`);
  const original = evaluate('JSON.stringify(event.proposals)');
  for (const [order, expected] of [
    ['availability-desc', '2026-12-02,2026-12-03,2026-12-04,2026-12-01'],
    ['availability-asc', '2026-12-01,2026-12-03,2026-12-04,2026-12-02'],
    ['date', '2026-12-01,2026-12-02,2026-12-03,2026-12-04']
  ]) {
    assert.equal(evaluate(`groupResultDays(event.proposals, '${order}').map(group => group.day).join(',')`), expected);
    assert.equal(evaluate(`groupResultDays(event.proposals, '${order}').find(group => group.day === '2026-12-01').slots.map(slot => slot.start).join(',')`),
      '2026-12-01T16:00:00Z,2026-12-01T18:00:00Z');
  }
  assert.equal(evaluate('JSON.stringify(event.proposals)'), original);
  assert.equal(evaluate("groupResultDays([], 'availability-desc').length"), 0);
});

test('all slot fractions are rendered directly, with no collapsed alternatives per day', () => {
  const { evaluate, node } = ui();
  evaluate(`event = { code: 'RESULTS', participants: [], proposals: ${JSON.stringify(resultFixtures)} }; renderResults();`);
  assert.equal(node('results-order').value, 'availability-desc');
  assert.equal(node('results').children[0].children[0].textContent, '02/12/2026');
  const slots = node('results').querySelectorAll('.slot-option');
  assert.equal(slots.length, resultFixtures.length);
  assert.equal(slots[0].children[0].children[1].textContent, 'Tothom · 13/13');
  assert.equal(slots[1].children[0].children[1].textContent, '10/13 disponibles');
  assert.equal(node('results').querySelectorAll('.remaining-slots').length, 0);
  assert.equal(node('results').children[0].dataset.full, 'true');
});

test('changing order preserves day filters and editing drafts across result reloads', () => {
  const { evaluate, node } = ui();
  evaluate(`event = { code: 'RESULTS', participants: [], proposals: ${JSON.stringify(resultFixtures)} }; renderResults();
    showPartialDays = false; selectedDays = new Set(['2026-12-01']); draftExcluded = new Set(['2026-12-04']);`);
  node('results-order').listeners.change({ target: { value: 'availability-asc' } });
  assert.equal(node('results').children[0].children[0].textContent, '01/12/2026');
  assert.equal(node('results').children[0].hidden, true);
  assert.equal(node('results').children[3].hidden, false);
  evaluate('renderResults();');
  assert.equal(node('results-order').value, 'availability-asc');
  assert.equal(evaluate('selectedDays.size'), 1);
  assert.equal(evaluate('draftExcluded.size'), 1);
  evaluate("event.code = 'NEW-EVENT'; renderResults();");
  assert.equal(node('results-order').value, 'availability-desc');
  assert(node('results').children.every(section => !section.hidden));
});

test('calendar freshness uses the same strict 24-hour threshold without expiring manual availability', () => {
  const { evaluate } = ui();
  assert.equal(evaluate('participantNeedsSync({ ready: true, updatedAt: null }, 86400001)'), false);
  assert.equal(evaluate('participantNeedsSync({ ready: false, updatedAt: null }, 86400001)'), true);
  assert.equal(evaluate("participantNeedsSync({ ready: true, updatedAt: '2026-11-06T13:41:21.214Z' }, Date.parse('2026-11-07T13:41:21.214Z'))"), false);
  assert.equal(evaluate("participantNeedsSync({ ready: true, updatedAt: '2026-11-06T13:41:21.214Z' }, Date.parse('2026-11-07T13:41:21.215Z'))"), true);
  assert.equal(evaluate("participantNeedsSync({ ready: true, updatedAt: 'invalid' })"), true);
});

test('pending calendars prevent definitive no-match wording and the hint disappears after synchronization', () => {
  const { evaluate, node } = ui();
  evaluate(`event = { code: 'PENDING', proposals: [], participants: [
    { ready: true, updatedAt: null }, { ready: true, updatedAt: '2020-01-01T00:00:00Z' }
  ] }; renderResults();`);
  assert.equal(node('result-summary').textContent, 'Encara no podem confirmar un horari per a tothom. 1 calendari pendent de sincronitzar.');
  assert.equal(node('calendar-refresh-hint').hidden, false);
  assert.equal(node('results-order').disabled, true);
  evaluate('event.participants[1].updatedAt = new Date().toISOString(); renderResults();');
  assert.equal(node('result-summary').textContent, 'Encara no hi ha cap horari per a tothom.');
  assert.equal(node('calendar-refresh-hint').hidden, true);
});
