// Збір повідомлень з ПУБЛІЧНИХ Telegram-каналів через веб-перегляд t.me/s/<канал>.
// Усе, крім офіційних каналів, позначається як НЕПІДТВЕРДЖЕНЕ і не змінює статус області.
const clean = s => s.trim().replace(/^@/, '').replace(/^https?:\/\/t\.me\/(s\/)?/, '').replace(/\/.*$/, '');
const EXTRA = (process.env.TG_CHANNELS || '').split(',').map(clean).filter(Boolean);
const OFFICIAL = new Set((process.env.TG_OFFICIAL || 'kpszsu').split(',').map(clean));
const CHANNELS = [...new Set([...OFFICIAL, ...EXTRA])];
const MAX_AGE = 3 * 3600000, HOT_MS = 30 * 60000;

const NL = '(?<![а-яіїєґ])', NR = '(?![а-яіїєґ])';
const REGIONS = [
  ['Вінницька область', /вінниц/], ['Волинська область', /волин/],
  ['Дніпропетровська область', /дніпропетр|дніпровщ|дніпро|дніпра/],
  ['Донецька область', /донеч|донецьк/], ['Житомирська область', /житомир/],
  ['Закарпатська область', /закарпат|ужгород/], ['Запорізька область', /запоріж/],
  ['Івано-Франківська область', /франківщ|франківськ|прикарпат/],
  ['Київська область', /київщин|київськ(а|ої|ій) обл/],
  ['м. Київ', new RegExp(`${NL}київ${NR}|${NL}києв[а-яіїєґ]*`)],
  ['Кіровоградська область', /кіровоград|кропивн/], ['Луганська область', /луган/],
  ['Львівська область', /львів/], ['Миколаївська область', /миколаїв/],
  ['Одеська область', /одещ|одес/], ['Полтавська область', /полтав/],
  ['Рівненська область', new RegExp(`рівненщ|рівненськ|рівне${NR}|рівного`)],
  ['Сумська область', new RegExp(`сумщин|сумськ|${NL}сум(и|ах|ам)${NR}`)],
  ['Тернопільська область', /терноп/], ['Харківська область', /харків|харьк/],
  ['Херсонська область', /херсон/], ['Хмельницька область', /хмельн/],
  ['Черкаська область', /черкащ|черкас/], ['Чернівецька область', /чернівц|буковин/],
  ['Чернігівська область', /чернігів/], ['Автономна Республіка Крим', new RegExp(`${NL}крим`)]
];

export function kind(t) {
  if (/шахед|герань|бпла|дрон|безпілот/.test(t)) return 'drone';
  if (/ракет|балістик|крилат|калібр|х-101|кінжал|іскандер|циркон/.test(t)) return 'missile';
  if (/відбій/.test(t)) return 'clear';
  if (/тривог/.test(t)) return 'alert';
  return null;
}
const dec = s => s.replace(/<br\s*\/?>/g, '\n').replace(/<[^>]+>/g, '')
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

export function parse(html) {
  const out = [];
  for (const p of html.split('tgme_widget_message_wrap').slice(1)) {
    const post = /data-post="([^"]+)"/.exec(p);
    const txt = /tgme_widget_message_text[^>]*>([\s\S]*?)<\/div>/.exec(p);
    const tm = /<time[^>]*datetime="([^"]+)"/.exec(p);
    if (post && txt && tm) out.push({ post: post[1], text: dec(txt[1]), published: new Date(tm[1]).toISOString() });
  }
  return out;
}
export const findRegions = low => REGIONS.filter(([, re]) => re.test(low)).map(([n]) => n);

export function hotRegions(db) {
  try {
    const since = new Date(Date.now() - HOT_MS).toISOString(), hot = {};
    for (const r of db.prepare("select regions from reports where published_at > ? and kind in ('drone','missile','alert')").all(since))
      for (const k of JSON.parse(r.regions)) hot[k] = (hot[k] || 0) + 1;
    return hot;
  } catch { return {}; }
}
export function queryReports(db, region, limit) {
  const lim = Math.min(+limit || 50, 200);
  return region
    ? db.prepare('select * from reports where regions like ? order by published_at desc limit ?').all(`%"${region}"%`, lim)
    : db.prepare('select * from reports order by published_at desc limit ?').all(lim);
}

export function startTelegram({ db, SOURCES, ensure, broadcast, pollMs = 45000 }) {
  db.exec(`create table if not exists reports(
    id integer primary key, channel text, post text unique, published_at text, fetched_at text,
    text text, kind text, regions text, url text, official integer)`);
  const ins = db.prepare('insert or ignore into reports(channel,post,published_at,fetched_at,text,kind,regions,url,official) values(?,?,?,?,?,?,?,?,?)');
  for (const ch of CHANNELS) SOURCES['tg_' + ch] = {
    id: 'tg_' + ch, name: `@${ch} (Telegram)`, url: 'https://t.me/' + ch, api: 'https://t.me/s/' + ch,
    reliability: OFFICIAL.has(ch) ? 'official' : 'unconfirmed', last_success: null, last_error: null, ok: false
  };
  async function one(ch) {
    const s = SOURCES['tg_' + ch], now = new Date().toISOString();
    try {
      const r = await fetch(s.api, { headers: { 'User-Agent': 'Mozilla/5.0 (air-alert-ukraine)' }, signal: AbortSignal.timeout(10000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const msgs = parse(await r.text());
      if (!msgs.length) throw new Error('повідомлень не знайдено (канал закритий або змінилась розмітка)');
      for (const m of msgs) {
        if (Date.now() - Date.parse(m.published) > MAX_AGE) continue;
        const low = m.text.toLowerCase(), k = kind(low);
        if (!k) continue;
        const regs = findRegions(low).map(n => ensure(n).key);
        ins.run(ch, m.post, m.published, now, m.text, k, JSON.stringify(regs), 'https://t.me/' + m.post, OFFICIAL.has(ch) ? 1 : 0);
      }
      s.last_success = now; s.ok = true; s.last_error = null;
    } catch (e) { s.ok = false; s.last_error = `${e.message} (${now})`; }
  }
  let busy = false;
  async function cycle() {
    if (busy) return; busy = true;
    for (const ch of CHANNELS) { await one(ch); await new Promise(r => setTimeout(r, 1500)); }
    busy = false; broadcast();
  }
  cycle(); setInterval(cycle, pollMs);
}
