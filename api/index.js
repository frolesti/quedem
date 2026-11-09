import { database, init, getEvent, people, savePerson, joinPerson, limit, cleanup, resolvePerson, completeCalendarConnection, manualPerson, selectManualPerson, clearManualPerson } from '../lib/db.js';
import { AppError, validateEvent, validateDates, datesFor, validateBlockedRanges, validateFlexibleConflicts, validateSeriesRules, isFlexible, partialConflicts, candidates, overlaps, rank, WINDOWS, ZONE } from '../lib/schedule.js';
import { session, requireOrigin, randomToken, eventCode, hash, encrypt, decrypt, cookie, setCookie, validToken } from '../lib/security.js';
import { config, PROVIDERS, authorization, exchange, calendars, googleAccount, refresh, busy, conflicts, canReadDetails } from '../lib/providers.js';

async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError('Cal enviar JSON.');
  if (req.body) {
    const text = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    if (Buffer.byteLength(text) > 20000) throw new AppError('Petició massa gran.', 413);
    try {
      const input = typeof req.body === 'object' ? req.body : JSON.parse(text);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid body');
      return input;
    } catch { throw new AppError('Cal enviar un objecte JSON vàlid.'); }
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 20000) throw new AppError('Petició massa gran.', 413);
    chunks.push(chunk);
  }
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString());
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid body');
    return input;
  }
  catch { throw new AppError('JSON no vàlid.'); }
}

export function ownView(person, event) {
  if (!person) return null;
  return {
    name: person.name, provider: person.provider, confirmed: person.confirmed,
    selected: person.selected, calendars: person.calendars,
    availableDates: person.availableDates, excludedDates: person.excludedDates,
    syncedAt: person.syncedAt,
    conflicts: person.conflicts ? decrypt(person.conflicts) : [],
    flexibleConflicts: person.flexibleConflicts ?? [],
    effectiveFlexibleConflicts: (person.busy ?? []).filter(period => isFlexible(person, period)).map(period => period.id),
    reviewedConflicts: person.reviewedConflicts ?? [],
    seriesRules: person.seriesRules ?? [],
    partialConflicts: event ? partialConflicts(event, person) : [],
    blockedRanges: person.blockedRanges ?? [],
    needsCalendarDetails: person.provider === 'google' && !person.detailsAvailable
  };
}

export function manualView(person) {
  return {
    name: person.name, provider: person.provider, manualOnly: true, confirmed: person.confirmed,
    availableDates: person.provider === 'manual' ? person.availableDates : [],
    excludedDates: person.excludedDates, blockedRanges: person.blockedRanges ?? [],
    selected: [], calendars: [], syncedAt: null, conflicts: [], flexibleConflicts: [],
    effectiveFlexibleConflicts: [], reviewedConflicts: [], seriesRules: [], partialConflicts: [],
    needsCalendarDetails: false
  };
}

const participantId = (code, sessionHash) => hash(`${code}:${sessionHash}`);

async function participantSession(req, code, browserHash) {
  const token = cookie(req, `quedem_edit_${code}`);
  return resolvePerson(code, browserHash, validToken(token) ? hash(token) : null);
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const url = new URL(req.url, process.env.APP_URL || 'http://localhost:3000');
  const path = url.pathname.replace(/^\/api\/?/, '').split('/').filter(Boolean);
  const send = (data, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
  const redirect = location => { res.statusCode = 303; res.setHeader('Location', location); res.end(); };
  try {
    if (req.method === 'GET' && path[0] === 'config') {
      return send({
        ready: Boolean(process.env.DATABASE_URL && process.env.APP_SECRET?.length >= 32),
        providers: Object.fromEntries(PROVIDERS.map(provider => [provider, Boolean(process.env[`${provider.toUpperCase()}_CLIENT_ID`] && process.env[`${provider.toUpperCase()}_CLIENT_SECRET`])])),
        windows: WINDOWS, zone: ZONE
      });
    }
    if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw new AppError('Mètode no permès.', 405);
    if (req.method !== 'GET') requireOrigin(req);
    await init();
    const ip = req.headers['x-vercel-forwarded-for'] || req.socket?.remoteAddress || 'local';
    await limit(`requests:${hash(String(ip))}`, 400);
    const sql = database();

    if (req.method === 'POST' && path.length === 1 && path[0] === 'events') {
      await limit(`create:${hash(String(ip))}`, 10);
      await cleanup();
      const data = validateEvent(await body(req));
      const code = eventCode();
      const owner = session(req, res, code);
      await sql`INSERT INTO quedem_events(code, data, owner) VALUES (${code}, ${JSON.stringify(data)}::jsonb, ${owner})`;
      return send({ code }, 201);
    }

    if (req.method === 'GET' && path[0] === 'oauth' && path[2] === 'callback') {
      const provider = path[1];
      const state = url.searchParams.get('state');
      if (!state) throw new AppError('Falta la verificació de l’autorització.', 403);
      const [pending] = await sql`DELETE FROM quedem_oauth WHERE state_hash=${hash(state)} AND provider=${provider}
        AND created_at > now() - interval '10 minutes' RETURNING *`;
      if (!pending) throw new AppError('L’autorització ha caducat o ja s’ha utilitzat. Torna a connectar el calendari.', 403);
      const token = cookie(req, `quedem_${pending.event_code}`);
      if (!validToken(token) || hash(token) !== (pending.browser_hash ?? pending.session_hash) ||
          (pending.recovering
            ? await manualPerson(pending.event_code, hash(token))
            : await participantSession(req, pending.event_code, hash(token))) !== pending.session_hash) {
        throw new AppError('L’autorització no correspon a aquest navegador.', 403);
      }
      const location = `/?event=${pending.event_code}`;
      if (url.searchParams.has('error')) return redirect(`${location}&notice=denied`);
      const code = url.searchParams.get('code');
      if (!code) throw new AppError('No s’ha rebut el codi d’autorització.', 400);
      const entries = await people(pending.event_code);
      const own = entries.find(entry => entry.session_hash === pending.session_hash);
      if (!own) throw new AppError('Primer entra a l’esdeveniment amb el teu nom.', 403);
      const tokens = await exchange(provider, { grant_type: 'authorization_code', code, code_verifier: pending.verifier });
      const available = await calendars(provider, tokens.access);
      if (!available.length) throw new AppError('No hem trobat calendaris consultables al teu compte.', 400);
      const calendarAccountId = provider === 'google' ? googleAccount(available) : null;
      if (pending.recovering) {
        if (provider !== 'google' || !['google', 'manual'].includes(own.data.provider)) {
          throw new AppError('Aquesta participació no es pot recuperar amb Google Calendar.', 403);
        }
        if (own.data.provider === 'google') {
          let previousAccount = own.data.calendarAccountId;
          if (!previousAccount) {
            try {
              const previousTokens = await refresh('google', decrypt(own.data.tokens));
              previousAccount = googleAccount(await calendars('google', previousTokens.access));
            } catch (error) {
              if (error instanceof AppError && error.status === 401) return redirect(`${location}&notice=original-browser`);
              throw error;
            }
          }
          if (previousAccount !== calendarAccountId) return redirect(`${location}&notice=wrong-account`);
        }
      }
      const preserve = provider === 'google' && own.data.provider === 'google' &&
        (pending.recovering || own.data.calendarAccountId === calendarAccountId);
      const selected = preserve ? own.data.selected.filter(id => available.some(calendar => calendar.id === id)) : [];
      const access = pending.recovering ? randomToken() : null;
      const previous = cookie(req, `quedem_edit_${pending.event_code}`);
      await completeCalendarConnection(pending.event_code, pending.session_hash, hash(token), own.data, {
        provider, calendarAccountId, tokens: encrypt(tokens), calendars: available, selected,
        ...(!preserve ? { busy: [], conflicts: null, flexibleConflicts: [], reviewedConflicts: [], seriesRules: [], syncedAt: null, confirmed: false } : {}),
        ...(preserve && !selected.length ? { syncedAt: null, confirmed: false } : {}),
        detailsAvailable: canReadDetails(provider, tokens)
      }, access ? { tokenHash: hash(access), previousHash: validToken(previous) ? hash(previous) : null } : null);
      if (access) setCookie(res, `quedem_edit_${pending.event_code}`, access);
      return redirect(`${location}&notice=connected`);
    }

    if (path[0] !== 'events' || !path[1]) throw new AppError('Ruta no trobada.', 404);
    await cleanup();
    const code = path[1].toUpperCase();
    const event = await getEvent(code);
    const browserHash = session(req, res, code);
    const privateSessionHash = await participantSession(req, code, browserHash);
    const entries = await people(code);
    const manualHash = await manualPerson(code, browserHash);
    const manualEntry = entries.find(entry => entry.session_hash === manualHash);
    const manualOnly = Boolean(manualEntry && manualHash !== privateSessionHash);
    const sessionHash = manualOnly ? manualHash : privateSessionHash;
    const own = entries.find(entry => entry.session_hash === sessionHash)?.data;
    const action = path[2];
    if (['recover', 'recovery'].includes(action)) throw new AppError('Ruta no trobada.', 404);
    if (req.method === 'GET' && !action) {
      return send({
        code, ...event.data, owner: event.owner === browserHash,
        editingId: own ? participantId(code, sessionHash) : null,
        privateParticipantId: entries.some(entry => entry.session_hash === privateSessionHash) ? participantId(code, privateSessionHash) : null,
        own: manualOnly ? manualView(own) : ownView(own, event.data),
        participants: entries.map(entry => ({
          id: participantId(code, entry.session_hash),
          name: entry.data.name,
          ready: entry.data.provider === 'manual' || Boolean(entry.data.syncedAt),
          updatedAt: entry.data.syncedAt
        })),
        proposals: rank(event.data, entries.map(entry => entry.data))
      });
    }
    if (req.method === 'DELETE' && !action) {
      if (event.owner !== browserHash) throw new AppError('Només l’organitzador pot eliminar l’esdeveniment des del navegador on el va crear.', 403);
      await sql`DELETE FROM quedem_events WHERE code=${code}`;
      return send({ deleted: true });
    }
    if (req.method === 'POST' && action === 'identify') {
      if (!event.data.namedAvailability) throw new AppError('Aquest pla antic no permet seleccionar participants pel nom.', 403);
      const input = await body(req);
      const target = entries.find(entry => participantId(code, entry.session_hash) === input.participantId);
      if (!target) throw new AppError('No hem trobat aquesta participació.', 404);
      await selectManualPerson(code, browserHash, target.session_hash);
      return send({ identified: true });
    }
    if (req.method === 'POST' && action === 'unidentify') {
      await clearManualPerson(code, browserHash);
      return send({ cleared: true });
    }
    if (manualOnly && !['blocks', 'connect'].includes(action)) {
      throw new AppError('Seleccionar un nom només permet editar bloquejos manuals. Autoritza Google Calendar per recuperar l’accés al teu calendari.', 403);
    }
    if (req.method === 'POST' && action === 'join') {
      const input = await body(req);
      const name = typeof input.name === 'string' ? input.name.normalize('NFKC').replace(/\s+/gu, ' ').trim() : '';
      if (!name || name.length > 40) throw new AppError('Indica el teu nom, amb un màxim de 40 caràcters.');
      await joinPerson(code, sessionHash, own ? { ...own, name } : {
        name, provider: 'manual', confirmed: true, calendars: [], selected: [], availableDates: datesFor(event.data),
        excludedDates: [], busy: [], syncedAt: null
      });
      return send({ joined: true });
    }
    if (!own) throw new AppError('Primer entra amb el teu nom.', 403);
    if (req.method === 'POST' && action === 'blocks') {
      const input = await body(req);
      const excludedDates = validateDates(input.excludedDates, event.data);
      const blockedRanges = validateBlockedRanges(input.blockedRanges, event.data);
      await savePerson(code, sessionHash, {
        ...own, excludedDates, blockedRanges,
        ...(own.provider === 'manual' ? {
          confirmed: true, availableDates: datesFor(event.data).filter(day => !excludedDates.includes(day))
        } : {})
      });
      return send({ saved: true });
    }
    if (req.method === 'DELETE' && action === 'leave') {
      await sql`DELETE FROM quedem_people WHERE event_code=${code} AND session_hash=${sessionHash}`;
      setCookie(res, `quedem_edit_${code}`, '', 0);
      return send({ deleted: true });
    }
    if (req.method === 'POST' && action === 'disconnect') {
      const { tokens, calendarAccountId, ...data } = own;
      await savePerson(code, sessionHash, {
        ...data, provider: 'manual', confirmed: true, availableDates: datesFor(event.data).filter(day => !own.excludedDates.includes(day)),
        calendars: [], selected: [], busy: [], conflicts: null, syncedAt: null, detailsAvailable: false,
        flexibleConflicts: [], reviewedConflicts: [], seriesRules: []
      });
      await sql`DELETE FROM quedem_oauth WHERE event_code=${code} AND session_hash=${sessionHash}`;
      return send({ disconnected: true });
    }
    if (req.method === 'POST' && action === 'availability') {
      const input = await body(req);
      if (!['manual', 'google', 'microsoft'].includes(input.provider)) throw new AppError('Tria com vols compartir la disponibilitat.');
      if (input.provider !== 'manual' && input.provider !== own.provider) throw new AppError('Connecta primer el teu calendari.');
      const data = {
        ...own,
        availableDates: validateDates(input.availableDates ?? [], event.data),
        excludedDates: validateDates(input.excludedDates ?? [], event.data),
        blockedRanges: validateBlockedRanges(input.blockedRanges ?? own.blockedRanges ?? [], event.data),
        flexibleConflicts: validateFlexibleConflicts(input.flexibleConflicts ?? own.flexibleConflicts ?? [], own),
        confirmed: true
      };
      if (input.provider === 'manual') {
        data.provider = 'manual'; data.busy = []; data.syncedAt = null;
        data.calendars = []; data.selected = []; data.conflicts = null; data.flexibleConflicts = []; data.reviewedConflicts = []; data.seriesRules = []; delete data.tokens; delete data.calendarAccountId;
      }
      await savePerson(code, sessionHash, data);
      return send({ saved: true });
    }
    if (req.method === 'POST' && action === 'connect') {
      const input = await body(req);
      if (manualOnly && (input.provider !== 'google' || !['manual', 'google'].includes(own.provider))) {
        throw new AppError('La recuperació des d’un altre navegador només està disponible amb Google Calendar.', 403);
      }
      config(input.provider);
      const state = randomToken();
      const verifier = randomToken();
      await sql`INSERT INTO quedem_oauth(state_hash, event_code, session_hash, browser_hash, provider, verifier, recovering)
        VALUES (${hash(state)}, ${code}, ${sessionHash}, ${browserHash}, ${input.provider}, ${verifier}, ${manualOnly})`;
      return send({ url: authorization(input.provider, state, verifier) });
    }
    if (req.method === 'POST' && action === 'flexibility') {
      const input = await body(req);
      const flexibleConflicts = validateFlexibleConflicts(input.flexibleConflicts, own);
      const reviewedConflicts = validateFlexibleConflicts(input.reviewedConflicts ?? own.reviewedConflicts ?? [], own);
      const seriesRules = validateSeriesRules(input.seriesRules ?? own.seriesRules ?? [], own);
      await savePerson(code, sessionHash, { ...own, flexibleConflicts, reviewedConflicts, seriesRules });
      return send({ saved: true });
    }
    if (req.method === 'POST' && action === 'sync') {
      const input = await body(req);
      if (!own.tokens || !PROVIDERS.includes(own.provider)) throw new AppError('Connecta primer Google o Outlook.');
      await limit(`sync:${code}:${sessionHash}`, 20);
      const selected = input.selected ?? own.selected;
      if (!Array.isArray(selected) || !selected.length || selected.length > 20 ||
          selected.some(id => !own.calendars.some(calendar => calendar.id === id))) {
        throw new AppError('Selecciona entre 1 i 20 calendaris del teu compte.');
      }
      const tokens = await refresh(own.provider, decrypt(own.tokens));
      const detailsAvailable = canReadDetails(own.provider, tokens);
      const slots = candidates(event.data).filter(slot => Date.parse(slot.start) > Date.now());
      const details = detailsAvailable
        ? (await conflicts(own.provider, tokens.access, selected, event.data, own.calendars)).filter(period => slots.some(slot => overlaps(slot, period)))
        : null;
      const periods = details ? details.map(({ id, start, end, seriesId }) => ({ id, start, end, ...(seriesId ? { seriesId } : {}) })) : await busy(own.provider, tokens.access, selected, event.data);
      const flexibleConflicts = (own.flexibleConflicts ?? []).filter(id => periods.some(period => period.id === id));
      const reviewedConflicts = (own.reviewedConflicts ?? []).filter(id => periods.some(period => period.id === id));
      const seriesRules = (own.seriesRules ?? []).filter(rule => periods.some(period => period.seriesId === rule.id));
      await savePerson(code, sessionHash, {
        ...own, tokens: encrypt(tokens), selected, busy: periods, conflicts: details ? encrypt(details) : null,
        detailsAvailable, flexibleConflicts, reviewedConflicts, seriesRules, syncedAt: new Date().toISOString(), confirmed: true
      });
      return send({ synced: true });
    }
    throw new AppError('Ruta no trobada.', 404);
  } catch (error) {
    if (!(error instanceof AppError)) console.error('Quedem request failed:', error.name, error.message?.replace(/postgres(?:ql)?:\/\/\S+/g, '[database]'));
    return send({ error: error instanceof AppError ? error.message : 'S’ha produït un error al servidor. Torna-ho a provar; si persisteix, contacta amb l’organitzador.' }, error instanceof AppError ? error.status : 500);
  }
}
