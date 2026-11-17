import express from 'express';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTelegram, hotRegions, queryReports, tgStatusFor, tgState } from './telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.ALERTS_TOKEN;
const POLL_MS = +process.env.POLL_MS || 30000;   // як часто опитувати джерело
const STALE_MS = +process.env.STALE_MS || 120000; // після цього дані вважаються застарілими
const CLEAR_MS = 15 * 60000;                      // скільки показувати «відбій» (зелений)
const GEO_FILE = path.join(__dirname, 'data', 'oblasts.geojson');
const GEO_URL = process.env.GEOJSON_URL ||
  'https://raw.githubusercontent.com/EugeneBorshch/ukraine_geojson/master/UA_FULL_Ukraine.geojson';

const SOURCES = {
  alerts_in_ua: {
    id: 'alerts_in_ua',
    name: 'alerts.in.ua (офіційні дані Повітряних сил та ОВА)',
    url: 'https://alerts.in.ua/',
    api: 'https://api.alerts.in.ua/v1/alerts/active.json',
    reliability: 'official',
    last_success: null, last_error: null, ok: false
  }
};

fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
const db = new Database(path.join(__dirname, 'data', 'alerts.db'));
db.exec(`
create table if not exists history(
  id integer primary key, region text, name text, status text,
  published_at text, fetched_at text, source text,
  unique(region, status, published_at));
create table if not exists regions(
  key text primary key, name text, status text,
  published_at text, fetched_at text, changed_at text, items text);
`);
const insHist = db.prepare('insert or ignore into history(region,name,status,published_at,fetched_at,source) values(?,?,?,?,?,?)');
const upReg = db.prepare(`insert into regions(key,name,status,published_at,fetched_at,changed_at,items) values(@key,@name,@status,@publishedAt,@fetchedAt,@changedAt,@items)
  on conflict(key) do update set name=@name,status=@status,published_at=@publishedAt,fetched_at=@fetchedAt,changed_at=@changedAt,items=@items`);

const regions = new Map();
for (const r of db.prepare('select * from regions').all())
  regions.set(r.key, { key: r.key, name: r.name, status: r.status, publishedAt: r.published_at,
    fetchedAt: r.fetched_at, changedAt: r.changed_at, items: JSON.parse(r.items || '[]') });

// Ключ області: "Рівненська область" -> "рівнен"; "м. Київ" -> "м_київ"
function key(n) {
  let s = (n || '').toLowerCase().replace(/[’'`ʼ]/g, '');
  let city = /^м\.|місто|city/.test(s);
  s = s.replace(/автономна республіка|область|обл\.|oblast|місто|city|м\./g, '').trim();
  if (s === 'київ' || s === 'kyiv' || s === 'kiev') city = true;
  return (city ? 'м_' : '') + s.slice(0, 6);
}
function ensure(name) {
  const k = key(name);
  if (!regions.has(k)) regions.set(k, { key: k, name, status: 'none', publishedAt: null, fetchedAt: null, changedAt: null, items: [] });
  return regions.get(k);
}

// ---- Межі областей (GeoJSON) ----
let geo = null;
async function loadGeo() {
  try {
    if (!fs.existsSync(GEO_FILE)) {
      const r = await fetch(GEO_URL, { signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      fs.writeFileSync(GEO_FILE, await r.text());
    }
    geo = JSON.parse(fs.readFileSync(GEO_FILE, 'utf8'));
    const props = geo.features[0].properties || {};
    const fld = ['name_uk', 'name:uk', 'NAME_UA', 'ADM1_UA', 'shapeName', 'name', 'NAME_1'].find(f => f in props)
      || Object.keys(props).find(k => typeof props[k] === 'string');
    for (const ft of geo.features) {
      ft.properties.title = ft.properties[fld];
      ft.properties.key = key(ft.properties.title);
      ensure(ft.properties.title);
    }
    console.log(`GeoJSON: ${geo.features.length} об'єктів, поле назви "${fld}"`);
  } catch (e) {
    console.error('GeoJSON не завантажено:', e.message, '\nПоклади файл меж областей у', GEO_FILE);
  }
}

// ---- Збір даних ----
function applyAlerts(alerts, now) {
  const active = new Map();
  for (const a of alerts) {
    if (a.finished_at) continue;
    const name = a.location_oblast || a.location_title;
    const k = key(name);
    const cur = active.get(k) || { name, items: [], started: a.started_at, updated: a.updated_at };
    cur.items.push({ title: a.location_title, type: a.location_type, kind: a.alert_type, started: a.started_at, updated: a.updated_at });
    if (a.started_at < cur.started) cur.started = a.started_at;
    if (a.updated_at > cur.updated) cur.updated = a.updated_at;
    active.set(k, cur);
  }
  for (const [k, a] of active) {
    const r = ensure(a.name);
    if (r.status !== 'alert') {
      r.status = 'alert'; r.changedAt = a.started;
      insHist.run(r.key, r.name, 'alert', a.started, now, 'alerts_in_ua');
    }
    r.publishedAt = a.updated; r.fetchedAt = now; r.items = a.items;
  }
  for (const r of regions.values()) {
    if (active.has(r.key)) continue;
    if (r.status === 'alert') {
      // Джерело віддає лише активні тривоги, тому час відбою = момент, коли ми побачили зникнення
      r.status = 'clear'; r.changedAt = now; r.publishedAt = now; r.items = [];
      insHist.run(r.key, r.name, 'clear', now, now, 'alerts_in_ua');
    } else if (r.status === 'clear' && Date.parse(now) - Date.parse(r.changedAt) > CLEAR_MS) {
      r.status = 'none'; r.changedAt = now;
    }
    r.fetchedAt = now;
  }
  db.transaction(() => { for (const r of regions.values()) upReg.run({ ...r, items: JSON.stringify(r.items) }); })();
}

async function poll() {
  const s = SOURCES.alerts_in_ua, now = new Date().toISOString();
  try {
    if (!TOKEN) throw new Error('не задано ALERTS_TOKEN');
    const r = await fetch(s.api, { headers: { Authorization: 'Bearer ' + TOKEN }, signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const j = await r.json();
    applyAlerts(j.alerts || [], now);
    s.last_success = now; s.ok = true; s.last_error = null;
  } catch (e) {
    s.ok = false; s.last_error = `${e.message} (${now})`;
  }
  broadcast();
}

function view() {
  const s = SOURCES.alerts_in_ua;
  const apiFresh = s.last_success && Date.now() - Date.parse(s.last_success) < STALE_MS;
  const tgOk = Object.values(SOURCES).some(x => x.id.startsWith('tg_') && x.reliability === 'official' && x.ok);
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const recent = db.prepare('select count(*) c from history where fetched_at > ?').get(hourAgo).c;
  const list = [...regions.values()].map(r => {
    const t = tgStatusFor(r.key);
    // Офіційний канал новіший за API (або API мертвий) — беремо його статус
    if (t && (!apiFresh || Date.parse(t.at) >= Date.parse(r.fetchedAt || 0))) {
      return { ...r, status: t.status, changedAt: r.status === t.status ? r.changedAt : t.at,
        publishedAt: t.at, fetchedAt: new Date().toISOString(), via: 'telegram', lastKnown: t.status, tgPost: t.post };
    }
    const status = apiFresh ? r.status : (tgOk ? 'none' : 'unknown');
    return { ...r, status, lastKnown: r.status, via: apiFresh ? 'api' : null };
  });
  return {
    serverTime: new Date().toISOString(), stale: !(apiFresh || tgOk), recent, hot: hotRegions(db),
    sources: Object.values(SOURCES).map(({ api, ...x }) => x),
    regions: list
  };
}

// ---- HTTP ----
const app = express();
const clients = new Set();
function broadcast() { const d = `data:${JSON.stringify(view())}\n\n`; clients.forEach(c => c.write(d)); }

app.get('/api/state', (_, res) => res.json(view()));
app.get('/api/geojson', (_, res) => geo ? res.json(geo) : res.status(404).json({ error: 'GeoJSON не завантажено' }));
app.get('/api/history', (req, res) => {
  const lim = Math.min(+req.query.limit || 50, 500);
  const rows = req.query.region
    ? db.prepare('select * from history where region=? order by published_at desc limit ?').all(req.query.region, lim)
    : db.prepare('select * from history order by published_at desc limit ?').all(lim);
  res.json(rows);
});
app.get('/api/reports', (req, res) => res.json(queryReports(db, req.query.region, req.query.limit)));
app.get('/api/stream', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  res.write(`data:${JSON.stringify(view())}\n\n`);
  req.on('close', () => clients.delete(res));
});
app.use('/vendor/leaflet', express.static(path.join(__dirname, 'node_modules', 'leaflet', 'dist')));
app.use(express.static(path.join(__dirname, 'public')));

await loadGeo();
poll(); setInterval(poll, POLL_MS);
startTelegram({ db, SOURCES, ensure, broadcast });
app.listen(PORT, () => console.log(`Air Alert Ukraine: http://localhost:${PORT}`));
