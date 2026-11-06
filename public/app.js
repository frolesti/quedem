const $ = id => document.getElementById(id);
const dateLabel = day => day.split('-').reverse().join('/');
const instant = value => `${dateLabel(localDay(value))}, ${timeLabel(value)}`;
const timeLabel = value => new Date(value).toLocaleTimeString('ca-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
const slotLabel = slot => `${timeLabel(slot.start)} – ${timeLabel(slot.end)}`;
const localDay = value => new Date(value).toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
const conflictTime = conflict => `${instant(conflict.start)} – ${localDay(conflict.start) === localDay(conflict.end) ? timeLabel(conflict.end) : instant(conflict.end)}`;
const durationLabel = minutes => minutes === 30 ? 'Mitja hora' : `${Math.floor(minutes / 60)} ${minutes < 120 ? 'hora' : 'hores'}${minutes % 60 ? ' i mitja' : ''}`;
let settings;
let event;
let mode;
let failedSync = false;
let pendingCalendarQueries = 0;
let draftExcluded = new Set();
let draftRanges = [];
let selectedDays = new Set();
let dayGesture;
let suppressDayClick = false;
let working = false;
let rangeDays = 14;
let calendarPanelKey;
let resultsEventCode;
let showPartialDays = true;

function showError(message) {
  if ($('block-dialog').open) {
    $('block-error').textContent = message;
    return;
  }
  $('error-message').textContent = message;
  if (!$('error-dialog').open) $('error-dialog').showModal();
}

function updatePlanSummary() {
  if (!settings) return;
  const form = $('create-form');
  const window = settings.windows[form.elements.window.value];
  $('plan-summary').textContent = form.elements.from.value && form.elements.to.value
    ? `${dateLabel(form.elements.from.value)} – ${dateLabel(form.elements.to.value)} · ${window.label}, ${window.start}–${window.end} h · ${form.elements.duration.selectedOptions[0].textContent}`
    : 'Tria els dies, la franja i la durada de la trobada.';
}

function addDays(day, amount) {
  const date = new Date(`${day}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10);
}

function updateDateRange(e) {
  const { from, to } = $('create-form').elements;
  if (!from.value) return updatePlanSummary();
  to.min = from.value; to.max = addDays(from.value, 59);
  if (!to.value || to.value < from.value) to.value = addDays(from.value, rangeDays);
  if (to.value > to.max) to.value = to.max;
  if (e?.target === to) rangeDays = Math.round((Date.parse(to.value) - Date.parse(from.value)) / 86400000);
  updatePlanSummary();
}

function updateDateInputs() {
  const { from, to } = $('create-form').elements;
  for (const [name, field] of [['from', from], ['to', to]]) {
    const input = $(`display-${name}`);
    input.value = field.value ? dateLabel(field.value) : '';
    input.setCustomValidity('');
  }
}

function readDateInput(input) {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(input.value);
  const day = match ? `${match[3]}-${match[2]}-${match[1]}` : '';
  const valid = day && !Number.isNaN(Date.parse(`${day}T12:00:00Z`)) && addDays(day, 0) === day;
  const field = $('create-form').elements[input.dataset.date];
  input.setCustomValidity(valid ? '' : 'Escriu una data vàlida en format dd/mm/aaaa.');
  field.value = valid ? day : '';
  if (!valid) return;
  const { from } = $('create-form').elements;
  if (input.dataset.date === 'from' && (day < from.min || day > from.max)) {
    input.setCustomValidity(`Tria una data entre ${dateLabel(from.min)} i ${dateLabel(from.max)}.`);
    return;
  }
  const end = $('create-form').elements.to.value;
  updateDateRange({ target: field });
  input.value = dateLabel(field.value);
  if ($('create-form').elements.to.value !== end) {
    $('display-to').value = dateLabel($('create-form').elements.to.value);
    $('display-to').setCustomValidity('');
  }
}

async function api(path, data, method = 'POST') {
  const response = await fetch(`/api/${path}`, {
    method, credentials: 'same-origin',
    ...(data === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'No s’ha pogut completar la petició.');
  return result;
}

function run(action) {
  return async e => {
    e?.preventDefault();
    if (working) return;
    working = true;
    const buttons = [...document.querySelectorAll('button')].filter(button => !button.disabled);
    buttons.forEach(button => { button.disabled = true; });
    applyDisabled();
    try { await action(e); }
    catch (error) { showError(error.message); }
    finally { working = false; buttons.forEach(button => { button.disabled = false; }); applyDisabled(); }
  };
}

function applyDisabled() {
  if (!settings) return;
  for (const provider of ['google', 'microsoft']) {
    $(provider).hidden = (!settings.providers[provider] && event?.own?.provider !== provider) ||
      (provider === 'microsoft' && Boolean(event?.own?.manualOnly));
    $(provider).disabled = working;
  }
  $('create-form').querySelector('button').disabled = !settings.ready || working;
  $('availability-form').querySelectorAll('fieldset').forEach(fieldset => { fieldset.disabled = working || pendingCalendarQueries > 0; });
  $('block-form').querySelectorAll('input, select').forEach(input => { input.disabled = working; });
  $('sync').disabled = working || !event?.own?.selected.length;
  $('existing-person').disabled = working;
  if (event?.own) updateDaySelection();
}

function renderCalendarPanel() {
  const key = `${event.code}:${event.editingId}:${event.own.provider}:${Boolean(event.own.manualOnly)}`;
  if (key !== calendarPanelKey) {
    calendarPanelKey = key;
    $('calendar-menu').open = !event.own.selected.length;
  }
  const count = event.own.selected.length;
  $('calendar-count').textContent = count ? `${count} ${count === 1 ? 'calendari seleccionat' : 'calendaris seleccionats'}` : 'Tria els calendaris';
}

function renderConnections() {
  $('connections').hidden = false;
  for (const [provider, label] of [['google', 'Google Calendar'], ['microsoft', 'Outlook']]) {
    $(provider).textContent = !event.own.manualOnly && event.own.provider === provider ? `Desconnectar ${label}` : `Connectar ${label}`;
  }
  $('reconnect-google').hidden = event.own.manualOnly || event.own.provider !== 'google' || !failedSync;
}

function check(value, label, selected) {
  const wrapper = document.createElement('label');
  wrapper.className = 'check';
  const input = document.createElement('input');
  input.type = 'checkbox'; input.value = value; input.checked = selected;
  const text = document.createElement('span'); text.textContent = label;
  wrapper.append(input, text);
  return wrapper;
}

function days() {
  const result = [];
  const cursor = new Date(`${event.from}T12:00:00Z`);
  while (cursor.toISOString().slice(0, 10) <= event.to) {
    result.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return result;
}

function renderAvailability() {
  $('calendars').hidden = event.own.manualOnly || mode === 'manual';
  $('conflict-review').hidden = event.own.manualOnly || mode === 'manual';
  $('review-connect').hidden = !event.own.needsCalendarDetails;
  $('conflicts-hint').textContent = event.own.needsCalendarDetails
    ? 'Reconnecta Google per veure els compromisos.'
    : !event.own.syncedAt ? 'Selecciona un calendari.'
    : event.own.conflicts.length ? '' : 'Cap compromís en aquest horari.';
  const effective = event.own.effectiveFlexibleConflicts ?? event.own.flexibleConflicts;
  const opened = new Set([...$('conflict-list').querySelectorAll('details[open]')].map(node => node.dataset.series));
  const conflictItem = (conflict, recurring = false) => {
    const flexible = effective.includes(conflict.id);
    const item = check(conflict.id, `${recurring ? '' : `${conflict.title} · `}${conflictTime(conflict)}`, flexible);
    item.querySelector('input').dataset.conflict = conflict.id;
    const state = document.createElement('small'); state.className = 'conflict-state';
    state.textContent = flexible ? 'Flexible' : 'Ocupat';
    item.querySelector('span').append(state);
    const container = document.createElement('div'); container.append(item);
    const partial = event.own.partialConflicts?.find(period => period.id === conflict.id);
    if (partial) {
      const question = document.createElement('div'); question.className = 'partial-question';
      const text = document.createElement('p');
      text.textContent = `Ocupa part de ${slotLabel(partial)}. Pots venir igualment?`;
      question.append(text);
      for (const [label, answer] of [['Sí, és flexible', 'yes'], ['No', 'no']]) {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary';
        button.textContent = label; button.dataset.conflict = conflict.id; button.dataset.answer = answer;
        question.append(button);
      }
      container.append(question);
    }
    return container;
  };
  const groups = new Map();
  event.own.conflicts.forEach(conflict => {
    const key = conflict.seriesId ?? conflict.id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(conflict);
  });
  $('conflict-list').replaceChildren(...[...groups.values()].map(items => {
    if (!items[0].seriesId) return conflictItem(items[0]);
    const group = document.createElement('section'); group.className = 'recurring-conflict';
    const sessions = document.createElement('details');
    sessions.dataset.series = items[0].seriesId; sessions.open = opened.has(items[0].seriesId);
    const summary = document.createElement('summary'); summary.textContent = `${items.length} ${items.length === 1 ? 'sessió' : 'sessions'}`;
    const toggle = document.createElement('small'); toggle.className = 'day-toggle';
    const show = document.createElement('span'); show.className = 'when-closed'; show.textContent = 'Veure sessions';
    const hide = document.createElement('span'); hide.className = 'when-open'; hide.textContent = 'Amagar sessions';
    toggle.append(show, hide); summary.append(toggle);
    const rule = event.own.seriesRules?.find(rule => rule.id === items[0].seriesId);
    const all = check(items[0].seriesId, `${items[0].title} · Tota la sèrie és flexible`, rule?.flexible ?? false);
    const input = all.querySelector('input'); input.dataset.series = items[0].seriesId;
    input.indeterminate = items.some(item => effective.includes(item.id)) && !items.every(item => effective.includes(item.id));
    if (input.indeterminate) input.checked = false;
    sessions.append(summary, ...items.map(item => conflictItem(item, item.title === items[0].title)));
    group.append(all, sessions); return group;
  }));
  $('days-hint').textContent = mode === 'manual'
    ? 'Bloqueja dies o hores; la resta comptarà com a disponible.'
    : 'Toca un dia o arrossega per bloquejar-ne diversos.';
  draftExcluded = new Set(event.own.excludedDates);
  if (mode === 'manual' && event.own.provider === 'manual' && event.own.confirmed) {
    days().filter(day => !event.own.availableDates.includes(day)).forEach(day => draftExcluded.add(day));
  }
  draftRanges = (event.own.blockedRanges ?? []).map(range => ({ ...range }));
  selectedDays.clear();
  renderDays();
  $('calendar-list').replaceChildren(...event.own.calendars.map(calendar => check(calendar.id, calendar.name, event.own.selected.includes(calendar.id))));
  renderCalendarPanel();
  applyDisabled();
}

function renderDays() {
  $('day-list').replaceChildren(...days().map(day => {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'day-choice secondary';
    button.dataset.day = day; button.setAttribute('aria-pressed', String(selectedDays.has(day)));
    const label = document.createElement('span'); label.textContent = dateLabel(day);
    const status = document.createElement('small');
    status.textContent = draftExcluded.has(day) ? 'Bloquejat'
      : draftRanges.filter(range => range.day === day).map(range => `${range.start}–${range.end}`).join(', ') || '';
    status.hidden = !status.textContent;
    button.classList.toggle('blocked', draftExcluded.has(day) || draftRanges.some(range => range.day === day));
    button.append(label, status); return button;
  }));
  updateDaySelection();
}

function updateDaySelection() {
  $('day-list').querySelectorAll('[data-day]').forEach(button => button.setAttribute('aria-pressed', String(selectedDays.has(button.dataset.day))));
  $('edit-days').disabled = !selectedDays.size;
  $('edit-days').hidden = !selectedDays.size;
  $('date-toolbar').hidden = !selectedDays.size;
  $('edit-days').textContent = `Bloquejar ${selectedDays.size} ${selectedDays.size === 1 ? 'dia' : 'dies'}`;
}

function openDayDialog() {
  if (!selectedDays.size) return;
  $('block-dates').textContent = [...selectedDays].sort().map(dateLabel).join(' · ');
  $('block-form').elements.scope.value = 'day';
  $('block-hours').hidden = true; $('block-error').textContent = '';
  $('block-hint').textContent = mode === 'manual' ? 'La resta de l’horari comptarà com a disponible.' : '';
  const window = settings.windows[event.window];
  const hours = [];
  for (let hour = Number(window.start.slice(0, 2)); hour <= Number(window.end.slice(0, 2)); hour++) hours.push(`${String(hour).padStart(2, '0')}:00`);
  const options = values => values.map(value => { const option = document.createElement('option'); option.value = value; option.textContent = value; return option; });
  $('block-start').replaceChildren(...options(hours.slice(0, -1)));
  $('block-end').replaceChildren(...options(hours.slice(1)));
  $('block-end').value = hours.at(-1);
  $('block-dialog').showModal();
}

function closeDayDialog() {
  selectedDays.clear();
  updateDaySelection();
  $('block-dialog').close();
}

function proposalOption(slot) {
  const row = document.createElement('details'); row.className = 'slot-option';
  const summary = document.createElement('summary'); summary.className = 'proposal';
  const time = document.createElement('span'); time.textContent = slotLabel(slot);
  const count = document.createElement('span'); count.className = `score${slot.all && slot.total > 1 ? ' all' : ''}`;
  count.textContent = slot.all && slot.total > 1 ? `Tothom · ${slot.available}/${slot.total}` : `${slot.available}/${slot.total} ${slot.available === 1 ? 'disponible' : 'disponibles'}`;
  const toggle = document.createElement('span'); toggle.className = 'day-toggle';
  const show = document.createElement('span'); show.className = 'when-closed'; show.textContent = 'Veure assistència';
  const hide = document.createElement('span'); hide.className = 'when-open'; hide.textContent = 'Amagar assistència';
  toggle.append(show, hide); summary.append(time, count, toggle); row.append(summary);
  if (slot.attendance) {
    const people = document.createElement('ul'); people.className = 'slot-attendance';
    people.append(...slot.attendance.map(person => {
      const item = document.createElement('li');
      const name = document.createElement('span'); name.textContent = person.name;
      const status = document.createElement('strong');
      status.textContent = { available: 'Pot venir', unavailable: 'No pot venir', pending: 'Pendent' }[person.status];
      item.append(name, status); return item;
    }));
    row.append(people);
  } else {
    const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = 'Aquest pla comparteix només recomptes.'; row.append(hint);
  }
  return row;
}

function updateResultFilter() {
  const sections = [...$('results').querySelectorAll('.result-day')];
  const partial = sections.filter(section => section.dataset.full === 'false');
  $('toggle-partial-days').hidden = !partial.length;
  $('toggle-partial-days').setAttribute('aria-expanded', String(showPartialDays));
  $('toggle-partial-days').textContent = `${showPartialDays ? 'Amagar' : 'Mostrar'} ${partial.length} ${partial.length === 1 ? 'dia' : 'dies'} sense coincidència completa`;
  partial.forEach(section => { section.hidden = !showPartialDays; });
  $('filtered-empty').hidden = showPartialDays || !partial.length || sections.some(section => section.dataset.full === 'true');
}

function renderIdentity() {
  $('join').hidden = Boolean(event.own);
  $('person').hidden = !event.own;
  $('identify').hidden = !event.namedAvailability || !event.participants.length;
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = event.privateParticipantId ? 'Tornar a la meva participació' : 'No hi soc: afegir-me';
  $('existing-person').replaceChildren(placeholder, ...event.participants.map(person => {
    const option = document.createElement('option'); option.value = person.id; option.textContent = person.name; return option;
  }));
  $('existing-person').value = event.editingId ?? '';
}

function render() {
  if (resultsEventCode !== event.code) {
    resultsEventCode = event.code;
    showPartialDays = true;
  }
  $('home').hidden = true; $('event').hidden = false;
  $('new-plan').hidden = false;
  $('event-title').textContent = event.title;
  $('event-meta').textContent = event.type;
  $('event-range').textContent = `${dateLabel(event.from)} – ${dateLabel(event.to)}`;
  $('event-window').textContent = `${settings.windows[event.window].label} · ${settings.windows[event.window].start}–${settings.windows[event.window].end} h`;
  $('event-duration').textContent = durationLabel(event.duration);
  $('share').textContent = navigator.share ? 'Compartir' : 'Copiar enllaç';
  $('invitation-link').value = `${location.origin}/?event=${event.code}`;
  $('delete-event').hidden = !event.owner;
  renderIdentity();
  $('join-privacy').textContent = event.namedAvailability
    ? 'El grup veurà quan pots venir i podrà editar els bloquejos manuals. Els calendaris són privats.'
    : 'El grup veurà quantes persones poden venir.';
  if (event.own) {
    mode = event.own.provider;
    $('person-name').textContent = event.own.manualOnly ? `Bloquejos de ${event.own.name}` : `Hola, ${event.own.name}`;
    $('leave').hidden = Boolean(event.own.manualOnly);
    $('sync-status').textContent = event.own.manualOnly ? 'Connecta el teu compte de Google per sincronitzar el calendari. Els bloquejos manuals ja es poden editar.'
      : mode === 'manual' ? 'Disponibilitat manual.'
      : (event.own.syncedAt ? `Actualitzat: ${instant(event.own.syncedAt)}.` : 'Selecciona els calendaris que vols compartir.');
    renderConnections();
    renderAvailability();
  }
  $('participants').replaceChildren(...event.participants.map(person => {
    const li = document.createElement('li');
    const name = document.createElement('span'); name.textContent = person.name;
    const status = document.createElement('small');
    status.textContent = !person.ready ? 'Pendent' : person.updatedAt && Date.now() - Date.parse(person.updatedAt) > 86400000 ? 'Cal actualitzar' : 'Disponibilitat compartida';
    li.append(name, status); return li;
  }));
  const all = event.proposals.some(slot => slot.all);
  const pendingCount = event.participants.filter(person => !person.ready || person.updatedAt && Date.now() - Date.parse(person.updatedAt) > 86400000).length;
  $('result-summary').textContent = !event.participants.length ? 'Comparteix l’enllaç per convidar el grup.'
    : event.participants.length === 1 ? 'Falta que s’hi afegeixi la resta del grup.'
    : all ? 'Hi ha horaris per a tothom.' : 'Encara no hi ha cap horari per a tothom.';
  if (pendingCount) $('result-summary').textContent += ` ${pendingCount} ${pendingCount === 1 ? 'persona pendent' : 'persones pendents'}.`;
  const grouped = new Map();
  for (const slot of event.proposals) {
    if (!grouped.has(slot.day)) grouped.set(slot.day, []);
    grouped.get(slot.day).push(slot);
  }
  $('results').replaceChildren(...[...grouped].sort(([a], [b]) => a.localeCompare(b)).map(([day, slots]) => {
    slots.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
    const section = document.createElement('section'); section.className = 'result-day';
    const heading = document.createElement('h3'); heading.textContent = dateLabel(day);
    const free = slots.filter(slot => slot.all);
    const other = slots.filter(slot => !slot.all);
    section.dataset.full = String(Boolean(free.length));
    const best = document.createElement('span'); best.className = 'day-best';
    best.textContent = free.length ? `${free.length} ${free.length === 1 ? 'horari' : 'horaris'} sense conflictes per a tothom` : 'Cap horari sense conflictes per a tothom.';
    const list = document.createElement('div'); list.className = 'day-slots';
    list.append(...free.map(proposalOption));
    section.append(heading, best, list);
    if (other.length) {
      const rest = document.createElement('details'); rest.className = 'remaining-slots';
      const summary = document.createElement('summary');
      const show = document.createElement('span'); show.className = 'when-closed'; show.textContent = `Altres horaris (${other.length})`;
      const hide = document.createElement('span'); hide.className = 'when-open'; hide.textContent = 'Amagar els altres horaris';
      summary.append(show, hide);
      const list = document.createElement('div'); list.className = 'day-slots'; list.append(...other.map(proposalOption));
      rest.append(summary, list); section.append(rest);
    }
    return section;
  }));
  if (!event.proposals.length) {
    const empty = document.createElement('p'); empty.className = 'hint';
    empty.textContent = 'Encara no hi ha cap coincidència. Afegiu disponibilitats o actualitzeu els calendaris.';
    $('results').append(empty);
  }
  updateResultFilter();
  applyDisabled();
}

async function syncCalendar(data = {}) {
  pendingCalendarQueries++;
  applyDisabled();
  try { await api(`events/${event.code}/sync`, data); }
  finally {
    pendingCalendarQueries--;
    applyDisabled();
  }
}

async function load(code, { sync = true } = {}) {
  event = await api(`events/${code}`, undefined, 'GET');
  render();
  if (sync && event.own && event.own.provider !== 'manual' && event.own.selected.length && !failedSync) {
    try {
      await syncCalendar();
      event = await api(`events/${code}`, undefined, 'GET');
      render();
    } catch (error) {
      failedSync = true;
      showError(`No s’ha pogut actualitzar el teu calendari: ${error.message}`);
      event = await api(`events/${code}`, undefined, 'GET');
      render();
    }
  }
}

$('create-form').addEventListener('submit', run(async e => {
  for (const name of ['from', 'to']) {
    if (!$(`display-${name}`).reportValidity()) return;
  }
  const data = Object.fromEntries(new FormData(e.target));
  data.duration = Number(data.duration);
  const result = await api('events', data);
  history.replaceState(null, '', `/?event=${result.code}`); await load(result.code);
}));
$('create-form').addEventListener('input', e => {
  if (e.target.dataset.date) readDateInput(e.target);
  else {
    updateDateRange(e);
    if (e.target.type === 'date') updateDateInputs();
  }
});
$('create-form').addEventListener('change', e => {
  if (e.target.dataset.date) readDateInput(e.target);
  else {
    updateDateRange(e);
    if (e.target.type === 'date') updateDateInputs();
  }
});
$('join-form').addEventListener('submit', run(async e => {
  await api(`events/${event.code}/join`, { name: new FormData(e.target).get('name') });
  await load(event.code);
}));
$('existing-person').addEventListener('change', run(async () => {
  const participantId = $('existing-person').value;
  try {
    await api(`events/${event.code}/${participantId ? 'identify' : 'unidentify'}`, participantId ? { participantId } : {});
    selectedDays.clear(); failedSync = false;
    await load(event.code, { sync: false });
    if (!event.own) $('join-form').elements.name.focus();
  } catch (error) {
    $('existing-person').value = event.editingId ?? '';
    throw error;
  }
}));

async function connectCalendar(provider) {
  const result = await api(`events/${event.code}/connect`, { provider });
  window.location.assign(result.url);
}
for (const provider of ['google', 'microsoft']) $(provider).addEventListener('click', run(async () => {
  if (event.own.manualOnly || event.own.provider !== provider) return connectCalendar(provider);
  if (!window.confirm('Vols desconnectar el calendari? S’eliminaran la connexió i els compromisos desats. Es conservaran els bloquejos manuals; la resta d’horaris comptarà com a disponible.')) return;
  await saveChange('disconnect', {});
  failedSync = false;
}));
$('reconnect-google').addEventListener('click', run(() => connectCalendar('google')));
$('review-connect').addEventListener('click', run(() => connectCalendar('google')));
$('edit-days').addEventListener('click', openDayDialog);
$('day-list').addEventListener('pointerdown', e => {
  const button = e.target.closest('[data-day]');
  if (!button || e.button !== 0 || !e.isPrimary || $('date-editor').disabled) return;
  const original = new Set(selectedDays);
  const selecting = !selectedDays.has(button.dataset.day);
  dayGesture = { pointer: e.pointerId, anchor: button.dataset.day, original, selecting };
  $('day-list').setPointerCapture(e.pointerId);
  button.focus({ preventScroll: true });
  if (selecting) selectedDays.add(button.dataset.day); else selectedDays.delete(button.dataset.day);
  updateDaySelection();
});
$('day-list').addEventListener('pointermove', e => {
  if (!dayGesture || e.pointerId !== dayGesture.pointer) return;
  const button = document.elementFromPoint(e.clientX, e.clientY)?.closest('#day-list [data-day]');
  if (!button) return;
  const range = [dayGesture.anchor, button.dataset.day].sort();
  selectedDays = new Set(dayGesture.original);
  for (const day of days().filter(day => day >= range[0] && day <= range[1])) {
    if (dayGesture.selecting) selectedDays.add(day); else selectedDays.delete(day);
  }
  updateDaySelection();
});
function finishDayGesture(e) {
  if (!dayGesture || e.pointerId !== dayGesture.pointer) return;
  const gesture = dayGesture; dayGesture = null;
  if ($('day-list').hasPointerCapture(e.pointerId)) $('day-list').releasePointerCapture(e.pointerId);
  if (e.type === 'pointercancel') {
    selectedDays = gesture.original; updateDaySelection(); return;
  }
  suppressDayClick = true;
  setTimeout(() => { suppressDayClick = false; }, 0);
  if (selectedDays.size) openDayDialog();
}
$('day-list').addEventListener('pointerup', finishDayGesture);
$('day-list').addEventListener('pointercancel', finishDayGesture);
$('day-list').addEventListener('lostpointercapture', e => {
  if (dayGesture?.pointer === e.pointerId) {
    selectedDays = dayGesture.original; dayGesture = null; updateDaySelection();
  }
});
$('day-list').addEventListener('click', e => {
  const button = e.target.closest('[data-day]');
  if (!button || suppressDayClick || e.detail > 0) return;
  if (selectedDays.has(button.dataset.day)) selectedDays.delete(button.dataset.day); else selectedDays.add(button.dataset.day);
  updateDaySelection();
  if (selectedDays.size) openDayDialog();
});
$('block-form').addEventListener('change', () => { $('block-hours').hidden = $('block-form').elements.scope.value !== 'range'; });
$('block-dialog').addEventListener('cancel', e => {
  if (working) e.preventDefault();
  else { selectedDays.clear(); updateDaySelection(); }
});
$('block-form').addEventListener('submit', e => {
  const action = e.submitter?.value;
  if (action === 'cancel') { e.preventDefault(); closeDayDialog(); return; }
  e.preventDefault();
  run(async () => {
    const rangeOnly = $('block-form').elements.scope.value === 'range';
    const start = $('block-start').value; const end = $('block-end').value;
    if (action === 'block' && rangeOnly && start >= end) {
      $('block-error').textContent = 'L’hora final ha de ser posterior a la inicial.'; return;
    }
    const excluded = new Set(draftExcluded);
    let ranges = draftRanges.map(range => ({ ...range }));
    for (const day of selectedDays) {
      if (action === 'clear' || !rangeOnly) ranges = ranges.filter(range => range.day !== day);
      if (action === 'clear' || rangeOnly) excluded.delete(day); else excluded.add(day);
      if (action === 'block' && rangeOnly) ranges.push({ day, start, end });
    }
    // Hour cells keep repeated batch edits free of duplicate or overlapping ranges.
    const cells = new Map();
    for (const range of ranges) {
      for (let hour = Number(range.start.slice(0, 2)); hour < Number(range.end.slice(0, 2)); hour++) {
        const start = `${String(hour).padStart(2, '0')}:00`;
        cells.set(`${range.day}:${start}`, { day: range.day, start, end: `${String(hour + 1).padStart(2, '0')}:00` });
      }
    }
    await saveAvailability(excluded, [...cells.values()]);
    closeDayDialog();
  })(e);
});

async function saveChange(action, data) {
  const selection = new Set(selectedDays);
  let saved = false;
  try {
    await api(`events/${event.code}/${action}`, data);
    saved = true;
    await load(event.code, { sync: false });
  } catch (error) {
    if (!saved) renderAvailability();
    if (saved) throw new Error('El canvi s’ha desat, però no s’han pogut carregar els resultats. Actualitza la pàgina.');
    throw error;
  } finally {
    selectedDays = selection; updateDaySelection();
  }
}

async function saveAvailability(excluded, blockedRanges, provider = mode) {
  if (event.own.manualOnly) return saveChange('blocks', { excludedDates: [...excluded], blockedRanges });
  await saveChange('availability', {
    provider, availableDates: provider === 'manual' ? days().filter(day => !excluded.has(day)) : [],
    excludedDates: [...excluded], blockedRanges
  });
}

async function saveConflict(id, flexible) {
  const chosen = new Set(event.own.flexibleConflicts);
  if (flexible) chosen.add(id); else chosen.delete(id);
  await saveChange('flexibility', {
    flexibleConflicts: [...chosen],
    reviewedConflicts: [...new Set([...(event.own.reviewedConflicts ?? []), id])]
  });
}

$('conflict-list').addEventListener('change', run(async e => {
  const input = e.target;
  if (input.dataset.series) {
    const id = input.dataset.series;
    const instances = new Set(event.own.conflicts.filter(conflict => conflict.seriesId === id).map(conflict => conflict.id));
    await saveChange('flexibility', {
      flexibleConflicts: event.own.flexibleConflicts.filter(value => !instances.has(value)),
      reviewedConflicts: (event.own.reviewedConflicts ?? []).filter(value => !instances.has(value)),
      seriesRules: [...(event.own.seriesRules ?? []).filter(rule => rule.id !== id), { id, flexible: input.checked }]
    });
  } else await saveConflict(input.dataset.conflict, input.checked);
}));
$('conflict-list').addEventListener('click', e => {
  const button = e.target.closest('button[data-conflict]');
  if (!button) return;
  run(() => saveConflict(button.dataset.conflict, button.dataset.answer === 'yes'))(e);
});
$('availability-form').addEventListener('submit', e => e.preventDefault());
async function updateCalendars() {
  const selected = [...$('calendar-list').querySelectorAll('input:checked')].map(input => input.value);
  try {
    await syncCalendar({ selected });
    await load(event.code, { sync: false });
    failedSync = false;
  } catch (error) {
    event = await api(`events/${event.code}`, undefined, 'GET');
    render();
    throw error;
  }
}
$('sync').addEventListener('click', run(updateCalendars));
$('calendar-list').addEventListener('change', run(updateCalendars));
$('share').addEventListener('click', run(async () => {
  const url = `${location.origin}/?event=${event.code}`;
  if (navigator.share) {
    try { await navigator.share({ title: event.title, text: 'Quan et va bé quedar?', url }); return; }
    catch (error) { if (error.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(url);
    $('share').textContent = 'Enllaç copiat';
    setTimeout(() => { $('share').textContent = navigator.share ? 'Compartir' : 'Copiar enllaç'; }, 3000);
  }
  catch {
    $('share-link').hidden = false;
    $('invitation-link').focus(); $('invitation-link').select();
    throw new Error('No s’ha pogut copiar. Copia l’enllaç que es mostra.');
  }
}));
$('reload').addEventListener('click', run(async () => { failedSync = false; await load(event.code); }));
$('toggle-partial-days').addEventListener('click', () => {
  showPartialDays = !showPartialDays;
  updateResultFilter();
});
$('leave').addEventListener('click', run(async () => {
  if (!window.confirm('Vols retirar la teva participació i eliminar les dades i l’autorització desades?')) return;
  await api(`events/${event.code}/leave`, undefined, 'DELETE');
  selectedDays.clear();
  await load(event.code);
}));
$('delete-event').addEventListener('click', run(async () => {
  if (!window.confirm('Vols eliminar aquest esdeveniment i totes les dades de tots els participants?')) return;
  await api(`events/${event.code}`, undefined, 'DELETE'); location.assign('/');
}));

async function start() {
  const params = new URLSearchParams(location.search);
  const oauthNotice = params.get('notice');
  params.delete('notice');
  if (oauthNotice !== null || location.hash) {
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}`);
  }
  settings = await api('config', undefined, 'GET');
  applyDisabled();
  const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Madrid' });
  const form = $('create-form');
  form.elements.from.min = today; form.elements.from.max = addDays(today, 365);
  form.elements.from.value = today; form.elements.to.value = addDays(today, 14);
  updateDateRange();
  updateDateInputs();
  if (!settings.ready) showError('El servei no està disponible. Torna-ho a provar més tard.');
  if (params.get('event')) await load(params.get('event').toUpperCase());
  if (oauthNotice === 'denied') showError('Has cancel·lat la connexió del calendari. Pots continuar bloquejant dies i hores manualment.');
  if (oauthNotice === 'wrong-account') showError('Aquest compte de Google no és el que està vinculat a la persona seleccionada. Torna a connectar amb el compte correcte.');
  if (oauthNotice === 'original-browser') showError('L’autorització antiga ha caducat i no podem verificar el compte. Reconnecta Google des del navegador on el vas connectar originalment; després podràs identificar-te aquí.');
}
start().catch(error => showError(error.message));
