const $ = s => document.querySelector(s);
const COLOR = { alert: '#d93025', none: '#3b4252', unknown: '#e0a800', clear: '#2e9e5b' };
const TITLE = { alert: 'ПОВІТРЯНА ТРИВОГА', none: 'ТРИВОГУ НЕ ОГОЛОШЕНО', unknown: 'ПОТРЕБУЄ ПЕРЕВІРКИ', clear: 'ВІДБІЙ ТРИВОГИ' };
const STATUS = { alert: 'Активна тривога', none: 'Тривогу не оголошено', unknown: 'Дані застарілі або джерело недоступне', clear: 'Відбій тривоги' };
const REL = { official: 'Офіційно підтверджена (дані Повітряних сил/ОВА)', public: 'Повідомлення з публічних джерел', unconfirmed: 'Непідтверджена інформація' };
const cfg = Object.assign({ sound: true, notify: false, regions: [] }, JSON.parse(localStorage.getItem('aa') || '{}'));
const save = () => localStorage.setItem('aa', JSON.stringify(cfg));
const tm = i => i ? new Date(i).toLocaleString('uk-UA', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' }) : '—';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let map, layer, state = null, known = null, selected = null, byKey = {};
map = L.map('map', { zoomControl: false, attributionControl: false, minZoom: 5, maxZoom: 10 }).setView([48.6, 31.2], 6);
L.control.zoom({ position: 'bottomright' }).addTo(map);

fetch('/api/geojson').then(r => { if (!r.ok) throw 0; return r.json(); }).then(g => {
  layer = L.geoJSON(g, {
    style: f => style(f.properties.key),
    onEachFeature: (f, l) => {
      l.on('click', () => openCard(f.properties.key));
      l.bindTooltip(f.properties.title.replace(/ область| oblast/i, ''), { permanent: true, direction: 'center', className: 'lbl' });
    }
  }).addTo(map);
  map.fitBounds(layer.getBounds());
}).catch(() => banner('Немає меж областей: поклади data/oblasts.geojson і перезапусти сервер.'));

function style(k) {
  const st = byKey[k]?.status || 'unknown', hot = state?.hot?.[k];
  return { fillColor: COLOR[st], fillOpacity: .78, color: hot ? '#ffd666' : '#14171c', weight: k === selected ? 3 : hot ? 3 : 1, dashArray: hot ? '6 4' : null };
}
const KIND = { drone: 'БпЛА', missile: 'Ракети', alert: 'Тривога', clear: 'Відбій' };
const repHtml = x => `<div class="item"><b>${KIND[x.kind]}</b> · ${x.official ? 'офіційний канал' : 'непідтверджено'}<small>@${esc(x.channel)} · опубліковано ${tm(x.published_at)} · отримано ${tm(x.fetched_at)}</small>${esc(x.text.slice(0, 220))}${x.text.length > 220 ? '…' : ''} <a href="${esc(x.url)}" target="_blank" rel="noopener">першоджерело</a></div>`;
function banner(t) { const b = $('#banner'); b.hidden = !t; b.textContent = t || ''; }

function render() {
  if (!state) return;
  byKey = Object.fromEntries(state.regions.map(r => [r.key, r]));
  const c = s => state.regions.filter(r => r.status === s).length;
  $('#sAlert').textContent = c('alert');
  $('#sNone').textContent = c('none') + c('clear');
  $('#sNew').textContent = state.recent;
  $('#sBad').textContent = state.sources.filter(s => !s.ok).length;
  $('#clock').textContent = 'отримано ' + (state.sources[0]?.last_success ? tm(state.sources[0].last_success) : 'ніколи');
  banner(state.stale ? 'Дані застарілі: джерело не відповідає. ' + (state.sources[0]?.last_error || '') : '');
  layer?.setStyle(f => style(f.properties.key));
  if (selected) openCard(selected, true);
}

// ---- Картка області ----
async function openCard(k, keep) {
  selected = k;
  const r = byKey[k]; if (!r) return;
  layer?.setStyle(f => style(f.properties.key));
  const src = state.sources[0];
  const hist = await fetch('/api/history?limit=5&region=' + encodeURIComponent(k)).then(x => x.json()).catch(() => []);
  const reps = await fetch('/api/reports?limit=5&region=' + encodeURIComponent(k)).then(x => x.json()).catch(() => []);
  const stale = r.status === 'unknown';
  $('#sheet').innerHTML = `
    <button class="x" id="cx" aria-label="Закрити">✕</button>
    <span class="pill" style="background:${COLOR[r.status]}">${STATUS[r.status]}</span>
    <h2>${TITLE[r.status]}</h2>
    ${stale ? `<div class="warn">Останній відомий статус: ${esc(STATUS[r.lastKnown])}. Не вважай його актуальним.</div>` : ''}
    <div class="row"><span>Область</span><span>${esc(r.name)}</span></div>
    <div class="row"><span>Статус</span><span>${STATUS[r.status]}</span></div>
    <div class="row"><span>Оголошено</span><span>${r.lastKnown === 'alert' ? tm(r.changedAt) : '—'}</span></div>
    <div class="row"><span>Остання публікація</span><span>${tm(r.publishedAt)}</span></div>
    <div class="row"><span>Отримано нами</span><span>${tm(r.fetchedAt)}</span></div>
    <div class="row"><span>Підтвердження</span><span>${REL[src.reliability]}</span></div>
    <div class="row"><span>Джерело</span><span><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a></span></div>
    ${r.items?.length ? `<div class="row"><span>Райони/громади</span><span>${r.items.map(i => esc(i.title)).join(', ')}</span></div>` : ''}
    ${reps.length ? '<p class="muted">Повідомлення з Telegram (не підтверджено офіційно)</p>' + reps.map(repHtml).join('') : ''}
    ${hist.length ? '<p class="muted">Історія області</p>' + hist.map(h => `<div class="item">${STATUS[h.status]}<small>${tm(h.published_at)}</small></div>`).join('') : ''}`;
  $('#sheet').classList.add('open');
  $('#cx').onclick = () => { selected = null; $('#sheet').classList.remove('open'); layer?.setStyle(f => style(f.properties.key)); };
}

// ---- Сповіщення ----
let ac; addEventListener('pointerdown', () => { ac = ac || new (window.AudioContext || webkitAudioContext)(); ac.resume(); });
function beep(kind) {
  if (!cfg.sound || !ac) return;
  (kind === 'alert' ? [880, 660, 880, 660] : [523, 659, 784]).forEach((f, i) => {
    const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime + i * .25;
    o.frequency.value = f; o.connect(g); g.connect(ac.destination);
    g.gain.setValueAtTime(.2, t); g.gain.exponentialRampToValueAtTime(.001, t + .22);
    o.start(t); o.stop(t + .25);
  });
}
function notify(s) {
  if (s.stale) return;
  const now = Object.fromEntries(s.regions.map(r => [r.key, r.lastKnown]));
  if (known) for (const r of s.regions) {
    const was = known[r.key];
    if (was === r.lastKnown || !['alert', 'clear'].includes(r.lastKnown)) continue;
    if (cfg.regions.length && !cfg.regions.includes(r.key)) continue;
    beep(r.lastKnown);
    if (cfg.notify && Notification.permission === 'granted')
      navigator.serviceWorker?.ready.then(reg => reg.showNotification(TITLE[r.lastKnown], { body: r.name, tag: r.key, icon: '/icon.svg' }));
  }
  known = now;
}

// ---- Потік даних ----
function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = e => { const s = JSON.parse(e.data); notify(s); state = s; render(); };
  es.onerror = () => banner('Немає зв’язку із сервером. Дані можуть бути застарілими.');
}
connect();

// ---- Панелі ----
function panel(title, html) {
  const p = $('#panel'); p.hidden = false;
  p.innerHTML = `<h2>${title}<button id="pc">Закрити</button></h2>${html}`;
  $('#pc').onclick = () => p.hidden = true;
}
$('#bHist').onclick = async () => {
  const h = await fetch('/api/history?limit=100').then(r => r.json());
  panel('Історія', h.length ? h.map(x => `<div class="item"><b style="color:${COLOR[x.status]}">${STATUS[x.status]}</b> · ${esc(x.name)}<small>опубліковано ${tm(x.published_at)} · отримано ${tm(x.fetched_at)}</small></div>`).join('') : '<p class="muted">Подій ще немає.</p>');
};
$('#bSrc').onclick = () => panel('Джерела', (state?.sources || []).map(s => `<div class="item"><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>
  <small>Статус: ${s.ok ? 'доступне' : 'недоступне'} · останній успіх: ${tm(s.last_success)}<br>Достовірність: ${REL[s.reliability]}${s.last_error ? '<br>Помилка: ' + esc(s.last_error) : ''}</small></div>`).join('')
  + '<p class="muted">Непідтверджені канали (Telegram тощо) не підключено, щоб не показувати чутки як факти.</p>');
$('#bSet').onclick = () => {
  const list = (state?.regions || []).slice().sort((a, b) => a.name.localeCompare(b.name, 'uk'));
  panel('Налаштування', `
    <label class="ck"><input type="checkbox" id="cS" ${cfg.sound ? 'checked' : ''}> Звук при тривозі та відбої</label>
    <label class="ck"><input type="checkbox" id="cN" ${cfg.notify ? 'checked' : ''}> Сповіщення браузера</label>
    <button id="cT">Перевірити звук</button>
    <p class="muted">Області для сповіщень. Нічого не вибрано — усі області.</p>
    ${list.map(r => `<label class="ck"><input type="checkbox" class="cr" value="${esc(r.key)}" ${cfg.regions.includes(r.key) ? 'checked' : ''}> ${esc(r.name)}</label>`).join('')}`);
  $('#cS').onchange = e => { cfg.sound = e.target.checked; save(); };
  $('#cT').onclick = () => beep('alert');
  $('#cN').onchange = async e => {
    if (e.target.checked && 'Notification' in window) e.target.checked = (await Notification.requestPermission()) === 'granted';
    cfg.notify = e.target.checked; save();
  };
  document.querySelectorAll('.cr').forEach(c => c.onchange = () => { cfg.regions = [...document.querySelectorAll('.cr:checked')].map(x => x.value); save(); });
};
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');

// ---- Стрічка Telegram ----
async function openFeed() {
  const r = await fetch('/api/reports?limit=60').then(x => x.json()).catch(() => []);
  panel('Стрічка Telegram', '<p class="muted">Автоматичний збір із публічних каналів. Області розпізнаються за текстом і можуть бути неточними. Це не офіційне підтвердження.</p>' + (r.length ? r.map(repHtml).join('') : '<p class="muted">Повідомлень поки немає.</p>'));
}
const fb = document.createElement('button'); fb.textContent = 'Стрічка'; fb.onclick = openFeed; document.querySelector('nav').prepend(fb);
const sty = document.createElement('style'); sty.textContent = '.top{flex-wrap:wrap}nav button{padding:5px 8px;font-size:13px}'; document.head.append(sty);
document.querySelector('.legend').insertAdjacentHTML('beforeend', ' <i style="--c:transparent;border:2px dashed #ffd666"></i>є непідтверджені повідомлення');
