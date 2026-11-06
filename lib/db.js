import { neon } from '@neondatabase/serverless';
import { AppError } from './schedule.js';

let initialized;
export function database() {
  if (!process.env.DATABASE_URL) throw new AppError('Falta connectar la base de dades. Els esdeveniments encara no es poden desar.', 503);
  return neon(process.env.DATABASE_URL);
}

export async function init() {
  if (!initialized) {
    initialized = (async () => {
      const sql = database();
      await sql`CREATE TABLE IF NOT EXISTS quedem_events (
        code text PRIMARY KEY, data jsonb NOT NULL, owner text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`CREATE TABLE IF NOT EXISTS quedem_people (
        event_code text NOT NULL REFERENCES quedem_events(code) ON DELETE CASCADE,
        session_hash text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(event_code, session_hash)
      )`;
      await sql`CREATE TABLE IF NOT EXISTS quedem_access (
        event_code text NOT NULL, token_hash text NOT NULL, person_hash text NOT NULL,
        kind text NOT NULL CHECK (kind IN ('link', 'browser')),
        PRIMARY KEY(event_code, token_hash),
        FOREIGN KEY(event_code, person_hash) REFERENCES quedem_people(event_code, session_hash) ON DELETE CASCADE
      )`;
      await sql`CREATE UNIQUE INDEX IF NOT EXISTS quedem_person_link
        ON quedem_access(event_code, person_hash) WHERE kind='link'`;
      await sql`CREATE TABLE IF NOT EXISTS quedem_manual_access (
        event_code text NOT NULL, browser_hash text NOT NULL, person_hash text NOT NULL,
        PRIMARY KEY(event_code, browser_hash),
        FOREIGN KEY(event_code, person_hash) REFERENCES quedem_people(event_code, session_hash) ON DELETE CASCADE
      )`;
      await sql`CREATE TABLE IF NOT EXISTS quedem_oauth (
        state_hash text PRIMARY KEY, event_code text NOT NULL REFERENCES quedem_events(code) ON DELETE CASCADE,
        session_hash text NOT NULL, provider text NOT NULL, verifier text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
      )`;
      await sql`ALTER TABLE quedem_oauth ADD COLUMN IF NOT EXISTS browser_hash text`;
      await sql`ALTER TABLE quedem_oauth ADD COLUMN IF NOT EXISTS recovering boolean NOT NULL DEFAULT false`;
      await sql`CREATE TABLE IF NOT EXISTS quedem_limits (
        key text PRIMARY KEY, count integer NOT NULL, expires_at timestamptz NOT NULL
      )`;
    })().catch(error => { initialized = undefined; throw error; });
  }
  return initialized;
}

export async function limit(key, maximum) {
  const sql = database();
  const rows = await sql`INSERT INTO quedem_limits (key, count, expires_at) VALUES (${key}, 1, now() + interval '1 hour')
    ON CONFLICT (key) DO UPDATE SET count = CASE WHEN quedem_limits.expires_at < now() THEN 1 ELSE quedem_limits.count + 1 END,
    expires_at = CASE WHEN quedem_limits.expires_at < now() THEN now() + interval '1 hour' ELSE quedem_limits.expires_at END
    RETURNING count`;
  if (rows[0].count > maximum) throw new AppError('Massa peticions. Torna-ho a provar més tard.', 429);
}

export async function getEvent(code) {
  if (!/^[A-F0-9]{14}$/.test(code)) throw new AppError('El codi de l’esdeveniment no és vàlid.', 404);
  const sql = database();
  const rows = await sql`SELECT * FROM quedem_events WHERE code=${code}`;
  if (!rows.length) throw new AppError('No hem trobat aquest esdeveniment.', 404);
  return rows[0];
}

export async function people(code) {
  const sql = database();
  return sql`SELECT session_hash, data FROM quedem_people WHERE event_code=${code}`;
}

export async function savePerson(code, sessionHash, data) {
  const sql = database();
  await sql`INSERT INTO quedem_people (event_code, session_hash, data) VALUES (${code}, ${sessionHash}, ${JSON.stringify(data)}::jsonb)
    ON CONFLICT (event_code, session_hash) DO UPDATE SET data=EXCLUDED.data`;
}

export async function joinPerson(code, sessionHash, data) {
  const sql = database();
  const [, rows] = await sql.transaction([
    sql`SELECT code FROM quedem_events WHERE code=${code} FOR UPDATE`,
    sql`INSERT INTO quedem_people (event_code, session_hash, data)
      SELECT ${code}, ${sessionHash}, ${JSON.stringify(data)}::jsonb
      WHERE NOT EXISTS (
        SELECT 1 FROM quedem_people WHERE event_code=${code} AND session_hash<>${sessionHash}
        AND lower(btrim(regexp_replace(normalize(data->>'name', NFKC), '[[:space:]]+', ' ', 'g')))
          = lower(${data.name})
      )
      ON CONFLICT (event_code, session_hash) DO UPDATE SET data=EXCLUDED.data
      RETURNING session_hash`
  ]);
  if (!rows.length) throw new AppError('Aquest nom ja participa en el pla. Si ets tu, selecciona’l a «Qui ets?». Si sou persones diferents, afegeix un cognom.', 409);
}
export async function resolvePerson(code, browserHash, editHash) {
  if (!editHash) return browserHash;
  const sql = database();
  const [access] = await sql`SELECT person_hash FROM quedem_access
    WHERE event_code=${code} AND token_hash=${editHash} AND kind='browser'`;
  return access?.person_hash ?? browserHash;
}

export async function completeCalendarConnection(code, personHash, browserHash, previous, patch, access) {
  const sql = database();
  const [rows] = await sql.transaction([
    sql`UPDATE quedem_people SET data=data || ${JSON.stringify(patch)}::jsonb
      WHERE event_code=${code} AND session_hash=${personHash}
      AND data->>'provider'=${previous.provider}
      AND (data->>'tokens') IS NOT DISTINCT FROM ${previous.tokens ?? null}
      AND (data->>'calendarAccountId') IS NOT DISTINCT FROM ${previous.calendarAccountId ?? null}
      RETURNING session_hash`,
    sql`INSERT INTO quedem_access(event_code, token_hash, person_hash, kind)
      SELECT ${code}, ${access?.tokenHash ?? null}, ${personHash}, 'browser'
      WHERE ${Boolean(access)} AND EXISTS (
        SELECT 1 FROM quedem_people WHERE event_code=${code} AND session_hash=${personHash} AND data->>'tokens'=${patch.tokens}
      )`,
    sql`DELETE FROM quedem_access WHERE event_code=${code} AND token_hash=${access?.previousHash ?? null} AND kind='browser'
      AND EXISTS (SELECT 1 FROM quedem_people WHERE event_code=${code} AND session_hash=${personHash} AND data->>'tokens'=${patch.tokens})`,
    sql`DELETE FROM quedem_manual_access WHERE event_code=${code} AND browser_hash=${browserHash}
      AND EXISTS (SELECT 1 FROM quedem_people WHERE event_code=${code} AND session_hash=${personHash} AND data->>'tokens'=${patch.tokens})`
  ]);
  if (!rows.length) throw new AppError('La connexió ha canviat mentre autoritzaves Google. Torna a connectar el calendari.', 409);
}

export async function manualPerson(code, browserHash) {
  const sql = database();
  const [access] = await sql`SELECT person_hash FROM quedem_manual_access
    WHERE event_code=${code} AND browser_hash=${browserHash}`;
  return access?.person_hash;
}

export async function selectManualPerson(code, browserHash, personHash) {
  const sql = database();
  await sql`INSERT INTO quedem_manual_access(event_code, browser_hash, person_hash)
    VALUES (${code}, ${browserHash}, ${personHash})
    ON CONFLICT(event_code, browser_hash) DO UPDATE SET person_hash=EXCLUDED.person_hash`;
}

export async function clearManualPerson(code, browserHash) {
  const sql = database();
  await sql`DELETE FROM quedem_manual_access WHERE event_code=${code} AND browser_hash=${browserHash}`;
}

export async function cleanup() {
  const sql = database();
  await sql`DELETE FROM quedem_events WHERE (data->>'to')::date < current_date - 7`;
  await sql`DELETE FROM quedem_oauth WHERE created_at < now() - interval '10 minutes'`;
  await sql`DELETE FROM quedem_limits WHERE expires_at < now()`;
}
