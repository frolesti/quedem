import { DateTime } from 'luxon';

export const ZONE = 'Europe/Madrid';
export const WINDOWS = {
  mati: { label: 'Matí', start: '09:00', end: '13:00' },
  dinar: { label: 'Dinar', start: '13:00', end: '16:00' },
  tarda: { label: 'Tarda', start: '16:00', end: '20:00' },
  vespre: { label: 'Vespre', start: '18:00', end: '22:00' },
  sopar: { label: 'Sopar', start: '20:00', end: '24:00' }
};

export class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export function datesFor(event) {
  const dates = [];
  let day = DateTime.fromISO(event.from, { zone: ZONE });
  const last = DateTime.fromISO(event.to, { zone: ZONE });
  while (day <= last) {
    dates.push(day.toISODate());
    day = day.plus({ days: 1 });
  }
  return dates;
}

export function validateEvent(input, now = DateTime.now().setZone(ZONE)) {
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      typeof input.from !== 'string' || typeof input.to !== 'string') {
    throw new AppError('Indica les dades i les dates de l’esdeveniment.');
  }
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  if (!title || title.length > 80 || !type || type.length > 40) {
    throw new AppError('Indica un nom (màxim 80 caràcters) i un tipus d’esdeveniment.');
  }
  const from = DateTime.fromISO(input.from ?? '', { zone: ZONE });
  const to = DateTime.fromISO(input.to ?? '', { zone: ZONE });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from ?? '') ||
      !/^\d{4}-\d{2}-\d{2}$/.test(input.to ?? '') || !from.isValid || !to.isValid ||
      from < now.startOf('day') || to < from || to.diff(from, 'days').days > 59 ||
      from.diff(now.startOf('day'), 'days').days > 365) {
    throw new AppError('Tria un interval de fins a 60 dies, dins del pròxim any.');
  }
  if (!Object.hasOwn(WINDOWS, input.window) || !Number.isInteger(input.duration) ||
      input.duration < 60 || input.duration > 240 || input.duration % 60 !== 0) {
    throw new AppError('Tria una franja i una durada d’1, 2, 3 o 4 hores.');
  }
  const event = { title, type, from: input.from, to: input.to, window: input.window, duration: input.duration, namedAvailability: true };
  if (candidates(event).length === 0) throw new AppError('La durada no cap dins de la franja triada.');
  return event;
}

export function candidates(event) {
  const window = WINDOWS[event.window];
  return datesFor(event).flatMap(day => {
    let start = DateTime.fromISO(`${day}T${window.start}`, { zone: ZONE });
    const end = window.end === '24:00'
      ? DateTime.fromISO(day, { zone: ZONE }).plus({ days: 1 })
      : DateTime.fromISO(`${day}T${window.end}`, { zone: ZONE });
    const result = [];
    while (start.plus({ minutes: event.duration }) <= end) {
      result.push({ day, start: start.toUTC().toISO(), end: start.plus({ minutes: event.duration }).toUTC().toISO() });
      start = start.plus({ hours: 1 });
    }
    return result;
  });
}

export function validateDates(values, event) {
  const allowed = new Set(datesFor(event));
  if (!Array.isArray(values) || values.length > 60 || values.some(day => !allowed.has(day))) {
    throw new AppError('La disponibilitat conté dates que no pertanyen a l’esdeveniment.');
  }
  return [...new Set(values)];
}

export function overlaps(slot, busy) {
  return Date.parse(slot.start) < Date.parse(busy.end) && Date.parse(busy.start) < Date.parse(slot.end);
}

export function blockedPeriod(range) {
  const start = DateTime.fromISO(`${range.day}T${range.start}`, { zone: ZONE });
  const end = range.end === '24:00'
    ? DateTime.fromISO(range.day, { zone: ZONE }).plus({ days: 1 })
    : DateTime.fromISO(`${range.day}T${range.end}`, { zone: ZONE });
  return { start: start.toUTC().toISO(), end: end.toUTC().toISO() };
}

export function validateBlockedRanges(values, event) {
  const allowed = new Set(datesFor(event));
  const window = WINDOWS[event.window];
  if (!Array.isArray(values) || values.length > 240 || values.some(range =>
    !range || typeof range !== 'object' || !allowed.has(range.day) || typeof range.start !== 'string' || typeof range.end !== 'string' ||
    !/^(?:[01]\d|2[0-3]):00$/.test(range.start) || !/^(?:[01]\d|2[0-4]):00$/.test(range.end) ||
    range.start < window.start || range.end > window.end || range.start >= range.end)) {
    throw new AppError('Tria franges d’hores senceres dins dels dies i de l’horari del pla (màxim 240).');
  }
  const result = [];
  for (const range of values.map(({ day, start, end }) => ({ day, start, end }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start))) {
    const previous = result.at(-1);
    if (previous?.day === range.day && range.start <= previous.end) {
      if (range.end > previous.end) previous.end = range.end;
    } else result.push(range);
  }
  return result;
}

export function partialConflicts(event, person, now = Date.now()) {
  const slots = candidates(event).filter(slot => Date.parse(slot.start) > now);
  return (person.busy ?? []).filter(period => period.id &&
    !isFlexible(person, period) && !person.reviewedConflicts?.includes(period.id) &&
    !person.seriesRules?.some(rule => rule.id === period.seriesId))
    .flatMap(period => {
      const partial = slots.find(slot => {
        const overlap = Math.min(Date.parse(slot.end), Date.parse(period.end)) - Math.max(Date.parse(slot.start), Date.parse(period.start));
        return overlap > 0 && overlap < Date.parse(slot.end) - Date.parse(slot.start);
      });
      return partial ? [{ id: period.id, start: partial.start, end: partial.end }] : [];
    });
}

export function attendance(person, slot) {
  if (person.provider !== 'manual' &&
      (!person.syncedAt || !Number.isFinite(Date.parse(person.syncedAt)))) return 'pending';
  if (person.excludedDates.includes(slot.day)) return 'unavailable';
  if (person.blockedRanges?.some(range => range.day === slot.day && overlaps(slot, blockedPeriod(range)))) return 'unavailable';
  if (person.provider === 'manual') return !person.confirmed || person.availableDates.includes(slot.day) ? 'available' : 'unavailable';
  return person.busy.some(period => overlaps(slot, period) && !isFlexible(person, period))
    ? 'unavailable' : 'available';
}

export function validateFlexibleConflicts(values, person) {
  if (!Array.isArray(values) || values.length > 100 ||
      values.some(id => typeof id !== 'string' || !person.busy.some(period => period.id === id))) {
    throw new AppError('Tria com a màxim 100 compromisos de la consulta actual. Si han canviat, torna a revisar-los.');
  }
  return [...new Set(values)];
}

export function isFlexible(person, period) {
  if (!period.id) return false;
  if (person.reviewedConflicts?.includes(period.id)) return Boolean(person.flexibleConflicts?.includes(period.id));
  const series = period.seriesId && person.seriesRules?.find(rule => rule.id === period.seriesId);
  return series ? series.flexible : Boolean(person.flexibleConflicts?.includes(period.id));
}

export function validateSeriesRules(values, person) {
  if (!Array.isArray(values) || values.length > 100 || values.some(rule =>
    !rule || typeof rule.id !== 'string' || typeof rule.flexible !== 'boolean' ||
    !person.busy.some(period => period.seriesId === rule.id)) ||
    new Set(values.map(rule => rule.id)).size !== values.length) {
    throw new AppError('Tria sèries de la consulta actual (màxim 100).');
  }
  return values.map(({ id, flexible }) => ({ id, flexible }));
}

export function rank(event, participants, now = Date.now()) {
  const results = candidates(event).filter(slot => Date.parse(slot.start) > now).map(slot => {
    const statuses = participants.map(person => ({ name: person.name, status: attendance(person, slot) }));
    const available = statuses.filter(person => person.status === 'available').length;
    return {
      ...slot, available, total: participants.length, checked: statuses.filter(person => person.status !== 'pending').length, all: available > 0 && available === participants.length,
      ...(event.namedAvailability ? { attendance: statuses } : {})
    };
  });
  results.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return results.filter(slot => slot.available > 0);
}
