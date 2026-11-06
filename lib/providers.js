import { AppError, datesFor, ZONE } from './schedule.js';
import { DateTime } from 'luxon';
import { hash } from './security.js';

export const PROVIDERS = ['google', 'microsoft'];
export function config(provider) {
  if (!PROVIDERS.includes(provider)) throw new AppError('Proveïdor de calendari desconegut.');
  const prefix = provider.toUpperCase();
  const clientId = process.env[`${prefix}_CLIENT_ID`];
  const secret = process.env[`${prefix}_CLIENT_SECRET`];
  if (!clientId || !secret) throw new AppError(`La connexió amb ${provider === 'google' ? 'Google' : 'Outlook'} encara no està configurada. Pots indicar disponibilitat manualment.`, 503);
  const base = provider === 'google' ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize';
  const tokenUrl = provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const scope = provider === 'google'
    ? 'https://www.googleapis.com/auth/calendar.events.readonly https://www.googleapis.com/auth/calendar.calendarlist.readonly'
    : 'offline_access Calendars.ReadBasic';
  if (!process.env.APP_URL) throw new AppError('Falta configurar l’adreça pública de l’aplicació.', 503);
  return { clientId, secret, base, tokenUrl, scope, redirect: `${process.env.APP_URL}/api/oauth/${provider}/callback` };
}

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
  if (!response.ok) {
    const status = response.status === 401 || response.status === 403 ? 401 : 502;
    throw new AppError(status === 401 ? 'El proveïdor ha rebutjat l’accés. Torna a connectar el calendari; en comptes d’empresa pot caldre permís de l’administrador.' : 'El proveïdor no ha pogut consultar el calendari. Torna-ho a provar.', status);
  }
  return response.json();
}

export function authorization(provider, state, verifier) {
  const c = config(provider);
  const url = new URL(c.base);
  const challenge = Buffer.from(hash(verifier), 'hex').toString('base64url');
  url.search = new URLSearchParams({
    client_id: c.clientId, redirect_uri: c.redirect, response_type: 'code', scope: c.scope,
    state, code_challenge: challenge, code_challenge_method: 'S256',
    ...(provider === 'google' ? { access_type: 'offline', prompt: 'consent' } : {})
  }).toString();
  return url.toString();
}

export async function exchange(provider, params) {
  const c = config(provider);
  const data = await request(c.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.clientId, client_secret: c.secret, redirect_uri: c.redirect, ...params })
  });
  if (typeof data.access_token !== 'string' || typeof data.expires_in !== 'number' ||
      data.scope !== undefined && typeof data.scope !== 'string') {
    throw new AppError('El proveïdor ha retornat una autorització incompleta.', 502);
  }
  return {
    access: data.access_token, refresh: data.refresh_token, expires: Date.now() + data.expires_in * 1000,
    scope: data.scope ?? (params.grant_type === 'authorization_code' ? c.scope : undefined)
  };
}

export async function refresh(provider, tokens) {
  if (tokens.expires > Date.now() + 60000) return tokens;
  if (!tokens.refresh) throw new AppError('L’autorització ha caducat. Torna a connectar el calendari.', 401);
  const next = await exchange(provider, { grant_type: 'refresh_token', refresh_token: tokens.refresh });
  return { ...next, refresh: next.refresh ?? tokens.refresh, scope: next.scope ?? tokens.scope };
}

async function pages(url, token, allowedHost) {
  const items = [];
  for (let page = 0; url; page++) {
    if (page >= 100 || new URL(url).hostname !== allowedHost || new URL(url).protocol !== 'https:') {
      throw new AppError('La resposta del proveïdor excedeix els límits de consulta.', 502);
    }
    const data = await request(url, { headers: { Authorization: `Bearer ${token}`, Prefer: 'outlook.timezone="UTC"' } });
    if (allowedHost === 'graph.microsoft.com') {
      if (!Array.isArray(data.value)) throw new AppError('Resposta d’Outlook no vàlida.', 502);
      items.push(...data.value);
      url = data['@odata.nextLink'];
    } else {
      if (!Array.isArray(data.items)) throw new AppError('Resposta de Google no vàlida.', 502);
      items.push(...data.items);
      const next = data.nextPageToken;
      if (next) {
        const nextUrl = new URL(url);
        nextUrl.searchParams.set('pageToken', next);
        url = nextUrl.toString();
      } else url = undefined;
    }
  }
  return items;
}

export async function calendars(provider, access) {
  const items = provider === 'google'
    ? await pages('https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=250', access, 'www.googleapis.com')
    : await pages('https://graph.microsoft.com/v1.0/me/calendars?$select=id,name,canEdit&$top=100', access, 'graph.microsoft.com');
  return items.filter(item => !item.deleted).map(item => ({
    id: item.id, name: provider === 'google' ? item.summary : item.name,
    ...(provider === 'google' ? { timeZone: item.timeZone ?? ZONE } : {})
  }));
}

export function canReadDetails(provider, tokens) {
  return provider === 'microsoft' || Boolean(tokens.scope?.split(' ').some(scope =>
    ['https://www.googleapis.com/auth/calendar.events.readonly', 'https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar'].includes(scope)));
}

export async function conflicts(provider, access, selected, event, availableCalendars) {
  if (!selected.length || selected.length > 20) throw new AppError('Selecciona entre 1 i 20 calendaris.');
  const start = DateTime.fromISO(event.from, { zone: ZONE }).toUTC().toISO();
  const end = DateTime.fromISO(event.to, { zone: ZONE }).plus({ days: 1 }).toUTC().toISO();
  const result = [];
  for (const id of selected) {
    const google = provider === 'google';
    const url = new URL(google
      ? `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(id)}/events`
      : `https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(id)}/calendarView`);
    url.search = new URLSearchParams(google
      ? { timeMin: start, timeMax: end, singleEvents: 'true', maxResults: '250', timeZone: ZONE,
          fields: 'items(id,summary,start,end,status,transparency,recurringEventId),nextPageToken' }
      : { startDateTime: start, endDateTime: end, '$select': 'id,subject,start,end,showAs,isCancelled,seriesMasterId', '$top': '100' }).toString();
    const items = await pages(url.toString(), access, google ? 'www.googleapis.com' : 'graph.microsoft.com');
    for (const item of items) {
      if (google ? item.status === 'cancelled' || item.transparency === 'transparent' : item.isCancelled || item.showAs === 'free') continue;
      const zone = google ? availableCalendars.find(calendar => calendar.id === id)?.timeZone ?? ZONE : 'UTC';
      const from = DateTime.fromISO(google ? item.start?.dateTime ?? item.start?.date ?? '' : item.start?.dateTime ?? '', { zone: google ? item.start?.timeZone ?? zone : zone });
      const to = DateTime.fromISO(google ? item.end?.dateTime ?? item.end?.date ?? '' : item.end?.dateTime ?? '', { zone: google ? item.end?.timeZone ?? zone : zone });
      if (!from.isValid || !to.isValid || to <= from || typeof item.id !== 'string' || !item.id) {
        throw new AppError('El calendari ha retornat un compromís incomplet. No el considerarem lliure.', 502);
      }
      const title = google ? item.summary : item.subject;
      const series = google ? item.recurringEventId : item.seriesMasterId;
      if (series != null && (typeof series !== 'string' || !series)) {
        throw new AppError('El calendari ha retornat una sèrie no vàlida.', 502);
      }
      result.push({
        id: hash(`${provider}:${id}:${item.id}:${from.toUTC().toISO()}:${to.toUTC().toISO()}`),
        ...(series ? { seriesId: hash(`${provider}:${id}:series:${series}`) } : {}),
        title: typeof title === 'string' && title.trim() ? title.slice(0, 500) : 'Compromís sense títol accessible',
        start: from.toUTC().toISO(), end: to.toUTC().toISO()
      });
    }
  }
  return result;
}

export function microsoftBusy(items) {
  return items.filter(item => !item.isCancelled && item.showAs !== 'free').map(item => {
    const start = DateTime.fromISO(item.start?.dateTime ?? '', { zone: 'UTC' });
    const end = DateTime.fromISO(item.end?.dateTime ?? '', { zone: 'UTC' });
    if (!start.isValid || !end.isValid || end <= start) throw new AppError('Outlook ha retornat un interval no vàlid.', 502);
    return { start: start.toISO(), end: end.toISO() };
  });
}

export async function busy(provider, access, selected, event) {
  if (!selected.length || selected.length > 20) throw new AppError('Selecciona entre 1 i 20 calendaris.');
  const days = datesFor(event);
  const start = DateTime.fromISO(days[0], { zone: ZONE }).toUTC().toISO();
  const end = DateTime.fromISO(days.at(-1), { zone: ZONE }).plus({ days: 1 }).toUTC().toISO();
  if (provider === 'google') {
    const data = await request('https://www.googleapis.com/calendar/v3/freeBusy', {
      method: 'POST', headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ timeMin: start, timeMax: end, timeZone: ZONE, items: selected.map(id => ({ id })) })
    });
    return selected.flatMap(id => {
      const calendar = data.calendars?.[id];
      if (!calendar || calendar.errors?.length || !Array.isArray(calendar.busy)) {
        throw new AppError('No s’ha pogut consultar un calendari seleccionat. No el considerarem lliure per error.', 502);
      }
      return calendar.busy.map(period => {
        if (!Number.isFinite(Date.parse(period.start)) || !Number.isFinite(Date.parse(period.end)) || Date.parse(period.end) <= Date.parse(period.start)) {
          throw new AppError('Google ha retornat un interval no vàlid.', 502);
        }
        return { start: period.start, end: period.end };
      });
    });
  }
  const periods = [];
  for (const id of selected) {
    const url = new URL(`https://graph.microsoft.com/v1.0/me/calendars/${encodeURIComponent(id)}/calendarView`);
    url.search = new URLSearchParams({ startDateTime: start, endDateTime: end, '$select': 'start,end,showAs,isCancelled', '$top': '100' }).toString();
    periods.push(...microsoftBusy(await pages(url.toString(), access, 'graph.microsoft.com')));
  }
  return periods;
}
