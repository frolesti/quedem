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
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, {
      textContent: '', hidden: false, disabled: false, value: '',
      addEventListener() {},
      setCustomValidity(value) { this.validationMessage = value; },
      replaceChildren(...children) { this.children = children; },
      querySelectorAll() { return []; },
      setAttribute(name, value) { this[name] = value; }
    });
    return nodes.get(id);
  };
  const elements = {
    from: { value: '2026-11-06' }, to: { value: '2026-11-20' },
    window: { value: 'tarda' }, duration: { selectedOptions: [{ textContent: '4 hores' }] }
  };
  node('create-form').elements = elements;
  const context = vm.createContext({
    document: { getElementById: node, createElement: () => ({}) },
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
