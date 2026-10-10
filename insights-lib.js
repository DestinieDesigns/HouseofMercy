/* House of Mercy Insights helpers: Meta Business Suite CSV parsing, validation, de-duplication and
   calculations. Pure functions (no DOM) so they can be unit tested with `node`. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.HOMInsights = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // Exact Meta Business Suite field names, in the order they are offered to the team.
  const FIELDS = [
    { key: 'title', label: 'Title', type: 'text', required: true },
    { key: 'date', label: 'Date published', type: 'date', required: true },
    { key: 'reach', label: 'Reach', type: 'number' },
    { key: 'likes', label: 'Likes and reactions', type: 'number' },
    { key: 'shares', label: 'Shares', type: 'number' },
    { key: 'watchTime', label: 'Watch time', type: 'number' },
    { key: 'avgPlayTime', label: 'Video average play time', type: 'number' },
    { key: 'views', label: 'Views', type: 'number' },
    { key: 'viewers', label: 'Viewers', type: 'number' },
    { key: 'interactions', label: 'Interactions', type: 'number' },
    { key: 'comments', label: 'Comments', type: 'number' },
    { key: 'saves', label: 'Saves', type: 'number' },
    { key: 'linkClicks', label: 'Link clicks', type: 'number' },
    { key: 'replies', label: 'Replies', type: 'number' },
    { key: 'follows', label: 'Follows', type: 'number' }
  ];
  const METRICS = FIELDS.filter(f => f.type === 'number');
  const LABEL = Object.fromEntries(FIELDS.map(f => [f.key, f.label]));
  // Metrics that cannot be meaningfully added across posts.
  const NON_ADDITIVE = {
    avgPlayTime: 'an average per video, so it is never added together',
    viewers: 'distinct people per post; the same person can be counted in several posts, so counts are never added together'
  };
  const isAdditive = key => !NON_ADDITIVE[key];
  const PLATFORMS = ['Instagram', 'Facebook', 'TikTok', 'YouTube', 'Threads'];

  // Extra header spellings accepted for convenience (the listed names always win).
  const ALIASES = {
    title: ['title', 'post title'],
    date: ['date published', 'publish time', 'published', 'publish date', 'date'],
    reach: ['reach'], likes: ['likes and reactions', 'likes', 'reactions'], shares: ['shares'],
    watchTime: ['watch time'], avgPlayTime: ['video average play time', 'average play time'],
    views: ['views'], viewers: ['viewers'], interactions: ['interactions'], comments: ['comments'],
    saves: ['saves'], linkClicks: ['link clicks'], replies: ['replies'], follows: ['follows'],
    platform: ['platform'], externalId: ['id', 'post id', 'record id', 'content id']
  };
  const normHeader = h => String(h ?? '').replace(/^\uFEFF/, '').trim().replace(/\s+/g, ' ').toLowerCase();

  function parseCSV(text) {
    const out = []; let row = [], cell = '', quote = false;
    text = String(text ?? '').replace(/^\uFEFF/, '');
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c === '"') { if (quote && text[i + 1] === '"') { cell += '"'; i++; } else quote = !quote; }
      else if (c === ',' && !quote) { row.push(cell); cell = ''; }
      else if ((c === '\n' || c === '\r') && !quote) {
        if (c === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); if (row.some(x => x.trim())) out.push(row); row = []; cell = '';
      } else cell += c;
    }
    row.push(cell); if (row.some(x => x.trim())) out.push(row);
    return out;
  }

  // Map header names to field keys regardless of column order. Returns {map:{key:index}, unknown:[headers]}.
  function mapHeaders(headers) {
    const map = {}, used = new Set(), norm = headers.map(normHeader);
    // First pass: the exact Meta field names; second pass: aliases.
    for (const pass of [0, 1]) {
      for (const [key, names] of Object.entries(ALIASES)) {
        if (map[key] !== undefined) continue;
        const list = pass === 0 ? names.filter(n => n === normHeader(LABEL[key] || n)) : names;
        const ix = norm.findIndex((h, i) => !used.has(i) && list.includes(h));
        if (ix >= 0) { map[key] = ix; used.add(ix); }
      }
    }
    return { map, unknown: headers.filter((_, i) => !used.has(i) && String(headers[i]).trim()) };
  }

  // Blank -> null (missing, NOT zero). Invalid -> {error}. Accepts 1,234 and clock formats for durations.
  function parseNumber(raw, key) {
    const s = String(raw ?? '').trim();
    if (s === '') return { value: null };
    if ((key === 'watchTime' || key === 'avgPlayTime') && /^\d{1,3}(:\d{2}){1,2}$/.test(s)) {
      const p = s.split(':').map(Number);
      if (p.slice(1).some(n => n > 59)) return { error: 'invalid time value' };
      return { value: p.reduce((a, n) => a * 60 + n, 0) };
    }
    const t = s.replace(/,/g, '');
    if (!/^\d+(\.\d+)?$/.test(t)) return { error: 'not a valid number' };
    const v = Number(t);
    return Number.isFinite(v) ? { value: v } : { error: 'not a valid number' };
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const pad = n => String(n).padStart(2, '0');
  function validYMD(y, m, d) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    return y >= 1970 && y <= 2100 && dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
  }
  function timeOf(str) {
    const m = /(\d{1,2}):(\d{2})(?::\d{2})?\s*(am|pm)?/i.exec(str || '');
    if (!m) return '';
    let h = +m[1]; const mi = +m[2];
    if (m[3]) { if (h < 1 || h > 12) return ''; h = h % 12 + (m[3].toLowerCase() === 'pm' ? 12 : 0); }
    return h > 23 || mi > 59 ? '' : `${pad(h)}:${pad(mi)}`;
  }
  // Returns {date:'YYYY-MM-DD', time:'HH:MM'|''} or {error}. Slash dates are read as MM/DD/YYYY (Meta US export).
  function parseDate(raw) {
    const s = String(raw ?? '').trim();
    if (!s) return { error: 'is blank' };
    let m, y, mo, d, rest;
    if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(.*)$/.exec(s))) { y = +m[1]; mo = +m[2]; d = +m[3]; rest = m[4]; }
    else if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(.*)$/.exec(s))) { y = +m[3]; mo = +m[1]; d = +m[2]; rest = m[4]; }
    else if ((m = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})(.*)$/.exec(s))) { y = +m[3]; mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; d = +m[2]; rest = m[4]; }
    else return { error: 'is not a recognised date' };
    if (!validYMD(y, mo, d)) return { error: 'is not a real calendar date' };
    if (rest && !/^[T,\s]+[\d:]{3,8}(\s*[ap]m)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.test(rest)) return { error: 'is not a recognised date' };
    return { date: `${y}-${pad(mo)}-${pad(d)}`, time: timeOf(rest) };
  }

  const clean = s => String(s ?? '').trim();
  const dupKey = r => [clean(r.platform).toLowerCase(), clean(r.title).toLowerCase(), r.date].join('|');

  // Build an import plan from CSV text. Nothing is saved here.
  function planImport(text, existing, opts = {}) {
    const rows = parseCSV(text);
    const result = { errors: [], missingColumns: [], items: [], headers: [], map: {}, unknown: [], rowCount: 0 };
    if (!rows.length) { result.errors.push({ row: 0, message: 'This CSV file is empty.' }); return result; }
    const headers = rows.shift().map(h => String(h).replace(/^\uFEFF/, '').trim());
    const { map, unknown } = mapHeaders(headers);
    Object.assign(result, { headers, map, unknown, rowCount: rows.length });
    for (const f of FIELDS.filter(f => f.required)) if (map[f.key] === undefined) result.missingColumns.push(f.label);
    if (result.missingColumns.length) {
      result.errors.push({ row: 1, message: `Missing required column${result.missingColumns.length > 1 ? 's' : ''}: ${result.missingColumns.join(', ')}. Found columns: ${headers.join(', ') || 'none'}.` });
      return result;
    }
    const byId = new Map(), byKey = new Map();
    (existing || []).forEach(e => { const n = normalizeRecord(e); if (n.externalId) byId.set(n.externalId, e); if (n.date && n.title) byKey.set(dupKey(n), e); });
    const seenInFile = new Set();
    rows.forEach((cells, i) => {
      const rowNo = i + 2, problems = [];
      const get = k => map[k] === undefined ? '' : cells[map[k]];
      const rec = { title: clean(get('title')) };
      if (!rec.title) problems.push('Title is blank');
      const dt = parseDate(get('date'));
      if (dt.error) problems.push(`Date published ${dt.error}${clean(get('date')) ? ` ("${clean(get('date'))}")` : ''}`);
      else { rec.date = dt.date; if (dt.time) rec.publishTime = dt.time; rec.dateOriginal = clean(get('date')); }
      for (const f of METRICS) {
        if (map[f.key] === undefined) continue;
        const n = parseNumber(get(f.key), f.key);
        if (n.error) problems.push(`${f.label} ${n.error} ("${clean(get(f.key))}")`);
        else if (n.value !== null) rec[f.key] = n.value; // blank cells are left out entirely
      }
      const plat = clean(get('platform')) || clean(opts.platform);
      if (plat) rec.platform = PLATFORMS.find(p => p.toLowerCase() === plat.toLowerCase()) || plat;
      const eid = clean(get('externalId'));
      if (eid) rec.externalId = eid;
      if (problems.length) { result.errors.push({ row: rowNo, message: `Row ${rowNo}: ${problems.join('; ')}.` }); return; }
      let status = 'new', match = null;
      if (eid && byId.has(eid)) { status = 'update'; match = byId.get(eid); }
      else if (byKey.has(dupKey(rec))) { status = 'duplicate'; match = byKey.get(dupKey(rec)); }
      else if (seenInFile.has(eid ? 'id|' + eid : dupKey(rec))) status = 'duplicate';
      seenInFile.add(eid ? 'id|' + eid : dupKey(rec));
      result.items.push({ row: rowNo, record: rec, status, matchId: match?.id });
    });
    return result;
  }

  // Legacy imports used different field names (content/engagement/time) and string values.
  function normalizeRecord(r) {
    const n = { ...r };
    if (n.title === undefined && r.content !== undefined) n.title = r.content;
    if (n.interactions === undefined && r.engagement !== undefined) n.interactions = r.engagement;
    if (n.publishTime === undefined && r.time) n.publishTime = r.time;
    for (const f of METRICS) {
      const v = n[f.key];
      if (v === undefined || v === null || v === '') delete n[f.key];
      else { const num = typeof v === 'number' ? v : parseNumber(v, f.key).value; if (num === null || num === undefined || Number.isNaN(num)) delete n[f.key]; else n[f.key] = num; }
    }
    return n;
  }
  const norm = rows => (rows || []).map(normalizeRecord);
  const has = (r, k) => typeof r[k] === 'number';

  // Merge an imported row into an existing record: blank cells never overwrite existing values.
  function mergeRecord(existing, incoming) {
    const out = { ...normalizeRecord(existing) };
    for (const [k, v] of Object.entries(incoming)) if (v !== undefined && v !== '') out[k] = v;
    return out;
  }

  function filterRecords(records, f = {}) {
    return records.filter(r => (!f.platform || r.platform === f.platform) && (!f.from || (r.date && r.date >= f.from)) && (!f.to || (r.date && r.date <= f.to)));
  }

  // Totals only over records that actually have the value; null when nothing has it.
  function summarize(records, key) {
    const vals = records.filter(r => has(r, key)).map(r => r[key]);
    const base = { n: vals.length, of: records.length };
    if (!vals.length) return { ...base, sum: null, min: null, max: null, median: null };
    const sorted = [...vals].sort((a, b) => a - b);
    return { ...base, sum: vals.reduce((a, b) => a + b, 0), min: sorted[0], max: sorted.at(-1), median: quantile(sorted, 0.5) };
  }
  function quantile(sorted, q) {
    const p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }
  const rank = (records, key, n = 5, dir = 'desc') => records.filter(r => has(r, key)).sort((a, b) => dir === 'desc' ? b[key] - a[key] : a[key] - b[key]).slice(0, n);

  function byDate(records, key) {
    const g = {};
    records.filter(r => r.date).forEach(r => (g[r.date] ||= []).push(r));
    return Object.keys(g).sort().map(date => ({ date, posts: g[date], count: g[date].length, ...summarize(g[date], key) }));
  }

  // Compare the selected range with the preceding range of equal length. Additive metrics only, and only
  // when both periods have at least `min` posts with the value.
  function compareRanges(records, key, from, to, min = 3) {
    if (!isAdditive(key)) return { status: 'unsupported', reason: `${LABEL[key]} is ${NON_ADDITIVE[key]}, so periods are not compared by total.` };
    if (!from || !to || from > to) return { status: 'need-range', reason: 'Choose a start and end date to compare with the previous period.' };
    const day = 86400000, t = s => Date.parse(s + 'T00:00:00Z'), iso = ms => new Date(ms).toISOString().slice(0, 10);
    const len = Math.round((t(to) - t(from)) / day) + 1, prevTo = iso(t(from) - day), prevFrom = iso(t(from) - len * day);
    const cur = summarize(records.filter(r => r.date >= from && r.date <= to), key), prev = summarize(records.filter(r => r.date >= prevFrom && r.date <= prevTo), key);
    if (cur.n < min || prev.n < min) return { status: 'insufficient', cur, prev, prevFrom, prevTo, reason: `Needs at least ${min} posts with ${LABEL[key]} in each period (this period: ${cur.n}, previous: ${prev.n}).` };
    return { status: 'ok', cur, prev, prevFrom, prevTo, avgCur: cur.sum / cur.n, avgPrev: prev.sum / prev.n };
  }

  const confidence = n => n >= 20 ? 'HIGH' : n >= 10 ? 'MODERATE' : 'LOW';

  // Findings grouped into Trends / Experiments / Outliers / Insufficient data. `events` are calendar events
  // used only to read the format of posts that the team linked to a performance record.
  function analyze(records, key, events = []) {
    const out = { trends: [], experiments: [], outliers: [], insufficient: [] };
    const label = LABEL[key], withVal = records.filter(r => has(r, key));
    if (withVal.length < 3) {
      out.insufficient.push({ text: `${label}: only ${withVal.length} post${withVal.length === 1 ? ' has' : 's have'} this value. At least 3 are needed before anything can be interpreted.` });
      return out;
    }
    // Outliers (Tukey fences) need enough posts for a spread to mean something.
    if (withVal.length >= 5) {
      const s = withVal.map(r => r[key]).sort((a, b) => a - b), q1 = quantile(s, .25), q3 = quantile(s, .75), iqr = q3 - q1;
      if (iqr > 0) withVal.forEach(r => {
        if (r[key] > q3 + 1.5 * iqr) out.outliers.push({ record: r, text: `“${r.title}” is unusually high for ${label} (${r[key].toLocaleString()} vs a typical middle range of ${q1.toLocaleString()}–${q3.toLocaleString()}).`, confidence: confidence(withVal.length), basis: `${withVal.length} posts with ${label}` });
        else if (r[key] < q1 - 1.5 * iqr) out.outliers.push({ record: r, text: `“${r.title}” is unusually low for ${label} (${r[key].toLocaleString()} vs a typical middle range of ${q1.toLocaleString()}–${q3.toLocaleString()}).`, confidence: confidence(withVal.length), basis: `${withVal.length} posts with ${label}` });
      });
    } else out.insufficient.push({ text: `Outliers for ${label}: at least 5 posts are needed (${withVal.length} available).` });

    const groupBy = (fn) => { const g = {}; withVal.forEach(r => { const k = fn(r); if (k) (g[k] ||= []).push(r); }); return g; };
    const describe = (name, g, note) => {
      const names = Object.keys(g).filter(k => g[k].length >= 5), few = Object.keys(g).filter(k => g[k].length < 5);
      if (names.length >= 2) {
        const meds = names.map(k => ({ k, med: quantile(g[k].map(r => r[key]).sort((a, b) => a - b), .5), n: g[k].length })).sort((a, b) => b.med - a.med);
        out.trends.push({ text: `${name}: ${meds[0].k} has the highest median ${label} (${meds[0].med.toLocaleString()}) compared with ${meds.slice(1).map(m => `${m.k} (${m.med.toLocaleString()})`).join(', ')}.${note || ''}`, confidence: confidence(Math.min(...meds.map(m => m.n)) * 2), basis: meds.map(m => `${m.k}: ${m.n} posts`).join(', ') });
      } else if (names.length + few.length >= 2) out.insufficient.push({ text: `${name} comparison for ${label}: each group needs at least 5 posts (${Object.keys(g).map(k => `${k}: ${g[k].length}`).join(', ')}).` });
      few.forEach(k => { if (g[k].length < 5) out.experiments.push({ text: `${name} “${k}”: ${g[k].length} post${g[k].length === 1 ? '' : 's'} so far (median ${label} ${quantile(g[k].map(r => r[key]).sort((a, b) => a - b), .5).toLocaleString()}). Still a test, not a conclusion.`, confidence: 'LOW', basis: `${g[k].length} post${g[k].length === 1 ? '' : 's'}` }); });
    };
    describe('Platform', groupBy(r => r.platform), ' Platforms may define this metric differently, so treat this as a rough guide.');
    const evById = new Map(events.map(e => [e.id, e]));
    describe('Content format', groupBy(r => evById.get(r.calendarEventId)?.format), '');
    describe('Content pillar / campaign', groupBy(r => evById.get(r.calendarEventId)?.pillar), '');

    // Direction over time: needs 8+ dated posts spanning at least 3 weeks; compares halves by median.
    const dated = withVal.filter(r => r.date).sort((a, b) => a.date.localeCompare(b.date));
    const span = dated.length ? (Date.parse(dated.at(-1).date) - Date.parse(dated[0].date)) / 86400000 : 0;
    if (dated.length >= 8 && span >= 21) {
      const half = Math.floor(dated.length / 2), a = quantile(dated.slice(0, half).map(r => r[key]).sort((x, y) => x - y), .5), b = quantile(dated.slice(-half).map(r => r[key]).sort((x, y) => x - y), .5);
      if (a > 0 && Math.abs(b - a) / a >= 0.2) out.trends.push({ text: `Median ${label} per post is ${b > a ? 'higher' : 'lower'} in the later half of the period (${b.toLocaleString()}) than in the earlier half (${a.toLocaleString()}).`, confidence: confidence(dated.length), basis: `${dated.length} dated posts over ${Math.round(span)} days` });
      else out.insufficient.push({ text: `${label} over time: no clear change between the earlier and later posts (${dated.length} dated posts).` });
    } else out.insufficient.push({ text: `${label} over time: at least 8 dated posts spread over 3 weeks are needed to describe a trend (${dated.length} posts, ${Math.round(span)} days).` });
    return out;
  }

  // Posting-time windows (2-hour blocks). Only reported when there are at least two comparable windows with 5+ posts each.
  function bestTimes(records) {
    const g = {};
    norm(records).forEach(r => {
      if (!r.platform || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(r.publishTime || '')) || !r.date || !has(r, 'interactions')) return;
      const d = new Date(r.date + 'T12:00:00'), hour = Math.floor(+r.publishTime.slice(0, 2) / 2) * 2;
      const k = `${r.platform}|${d.getDay()}|${hour}`;
      (g[k] ||= { platform: r.platform, day: d.toLocaleDateString(undefined, { weekday: 'long' }), hour, count: 0, score: 0 }).count++;
      g[k].score += r.interactions;
    });
    const ok = Object.values(g).filter(x => x.count >= 5);
    if (ok.length < 2) return [];
    const h12 = h => `${h % 12 || 12}${h % 24 < 12 ? ' AM' : ' PM'}`;
    return ok.sort((a, b) => b.score / b.count - a.score / a.count).slice(0, 6).map(x => ({ ...x, range: `${h12(x.hour)}–${h12(x.hour + 2)}` }));
  }

  return { FIELDS, METRICS, LABEL, NON_ADDITIVE, PLATFORMS, isAdditive, parseCSV, mapHeaders, parseNumber, parseDate, planImport, normalizeRecord, norm, mergeRecord, filterRecords, summarize, rank, byDate, compareRanges, analyze, bestTimes, confidence, dupKey };
});
