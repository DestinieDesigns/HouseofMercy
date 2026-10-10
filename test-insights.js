'use strict';
// Unit tests for insights-lib.js: node test-insights.js
const assert = require('assert');
const L = require('./insights-lib.js');

// Reordered columns, blank cells, platform column, extra unknown column.
let p = L.planImport('Reach,Notes,Date published,Title,Platform,Views\n"1,000",x,"Oct 5, 2026","Sunday, praise",Instagram,\n', []);
assert.deepEqual(p.errors, []);
assert.equal(p.items[0].record.title, 'Sunday, praise');
assert.equal(p.items[0].record.date, '2026-10-05');
assert.equal(p.items[0].record.reach, 1000);
assert.equal(p.items[0].record.platform, 'Instagram');
assert.deepEqual(p.unknown, ['Notes']);

p = L.planImport('Reach,Date published,Title,Views,Video average play time\n"1,200",2026-10-05,A,,00:01:30\n,10/06/2026,B,45,\n', []);
assert.equal(p.items[0].record.reach, 1200);
assert.equal('views' in p.items[0].record, false, 'blank views stays missing');
assert.equal(p.items[0].record.avgPlayTime, 90);
assert.equal('reach' in p.items[1].record, false, 'blank reach stays missing, not 0');
assert.equal(p.items[1].record.date, '2026-10-06');

// Missing required columns, invalid dates and numbers.
p = L.planImport('Title,Reach\nA,5\n', []);
assert.deepEqual(p.missingColumns, ['Date published']);
assert.match(p.errors[0].message, /Missing required column: Date published/);
p = L.planImport('Title,Date published,Reach,Saves\nA,2026-13-45,5,1\nB,2026-02-30,5,1\nC,2026-10-05,abc,1\nD,2026-10-05,-4,1\nE,2026-10-05,5,2\n', []);
assert.equal(p.items.length, 1); assert.equal(p.errors.length, 4);
assert.match(p.errors[0].message, /Row 2.*Date published/);
assert.match(p.errors[2].message, /Reach not a valid number \("abc"\)/);
assert.match(p.errors[3].message, /Reach/);
assert.match(L.planImport('', []).errors[0].message, /empty/);

// Duplicates: stable id updates; platform+title+date asks; blank cells never overwrite.
const existing = [{ id: 'r1', externalId: '99', title: 'A', date: '2026-10-05', platform: 'Instagram', reach: 10, views: 7 }, { id: 'r2', title: 'Legacy', date: '2026-10-01', platform: 'Facebook' }];
p = L.planImport('Post ID,Title,Date published,Reach,Views\n99,Renamed,2026-10-05,20,\n,Legacy,2026-10-01,3,\n,A,2026-10-05,3,\n', existing, { platform: 'Facebook' });
assert.deepEqual(p.items.map(i => i.status), ['update', 'duplicate', 'new']);
const merged = L.mergeRecord(existing[0], p.items[0].record);
assert.equal(merged.reach, 20); assert.equal(merged.views, 7);
const f = L.planImport('Title,Date published\nX,2026-10-05\nx ,2026-10-05\n', []);
assert.deepEqual(f.items.map(i => i.status), ['new', 'duplicate']);

// Calculations never invent values.
const recs = L.norm([{ title: 'a', date: '2026-10-01', reach: 100, avgPlayTime: 10, viewers: 5 }, { title: 'b', date: '2026-10-02', reach: '50' }, { title: 'c', date: '2026-10-03' }]);
assert.deepEqual([L.summarize(recs, 'reach').sum, L.summarize(recs, 'reach').n], [150, 2]);
assert.equal(L.summarize(recs, 'follows').sum, null);
assert.equal(L.isAdditive('avgPlayTime'), false); assert.equal(L.isAdditive('viewers'), false);
assert.equal(L.rank(recs, 'reach')[0].title, 'a');
assert.equal(L.compareRanges(recs, 'viewers', '2026-10-01', '2026-10-03').status, 'unsupported');
assert.equal(L.compareRanges(recs, 'reach', '2026-10-01', '2026-10-03').status, 'insufficient');
assert.equal(L.analyze(recs, 'reach').trends.length, 0);
assert.equal(L.analyze(recs, 'reach').insufficient.length > 0, true);
assert.deepEqual(L.bestTimes(recs), []);
const many = Array.from({ length: 12 }, (_, i) => ({ title: 'p' + i, date: `2026-09-${String(i + 1).padStart(2, '0')}`, reach: i === 11 ? 5000 : 100 + i }));
const a = L.analyze(many, 'reach'); assert.equal(a.outliers.length, 1); assert.equal(a.outliers[0].confidence, 'MODERATE');
console.log('insights-lib tests passed');
