'use strict';
// Integration test: node test.js (uses a temporary database).
const os = require('os'), path = require('path'), assert = require('assert');
process.env.HOM_DB = path.join(os.tmpdir(), `hom-test-${process.pid}.db`);
process.env.HOM_ADMIN_INITIAL_PASSWORD = 'TestAdminTemp2026';
const server = require('./server.js');
let cookieOf = {};
async function call(who, method, url, body) {
  const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', ...(cookieOf[who] ? { Cookie: cookieOf[who] } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get('set-cookie'); if (sc) cookieOf[who] = sc.split(';')[0];
  return { status: r.status, body: await r.json().catch(() => ({})) };
}
let base;
(async () => {
  await new Promise(r => server.listen(0, r)); base = `http://localhost:${server.address().port}`;
  const W = '/api/w/house-of-mercy';
  assert.equal((await call('x', 'GET', '/api/me')).status, 401);

  let r = await call('admin', 'POST', '/api/login', { username: 'hommediaadmin', password: 'TestAdminTemp2026' });
  assert.equal(r.status, 200); assert.equal(r.body.user.passwordRequiresChange, true);
  assert.equal(JSON.stringify(r.body).includes('pw_hash'), false);
  assert.equal((await call('admin', 'GET', W)).status, 403);
  assert.equal((await call('admin', 'POST', '/api/change-password', { newPassword: 'AdminPass2026', confirmPassword: 'no-match' })).status, 400);
  r = await call('admin', 'POST', '/api/change-password', { newPassword: 'AdminPass2026', confirmPassword: 'AdminPass2026' });
  assert.equal(r.status, 200);
  let st = (await call('admin', 'GET', W)).body;
  assert.equal(st.me.username, 'HOMMediaAdmin');
  assert.equal(st.me.email, undefined);

  r = await call('admin', 'POST', W + '/members', { firstName: 'Sarah', lastName: 'Johnson', username: 'SarahJ', temporaryPassword: 'TempPass2026', role: 'Contributor' });
  assert.equal(r.status, 201); const sarahId = r.body.member.id;
  assert.equal(r.body.member.status, 'Pending Password Setup');
  assert.equal(JSON.stringify(r.body).includes('TempPass2026'), false);
  assert.equal((await call('admin', 'POST', W + '/members', { firstName: 'Sally', lastName: 'Jones', username: 'sarahj', temporaryPassword: 'TempPass2026', role: 'Editor' })).status, 409);
  assert.equal((await call('admin', 'POST', W + '/members', { firstName: 'Bad', lastName: 'Username', username: 'bad name', temporaryPassword: 'TempPass2026', role: 'Editor' })).status, 400);
  st = (await call('admin', 'GET', W)).body;
  assert.equal(st.members.find(m => m.id === sarahId).username, 'SarahJ');
  assert.equal(JSON.stringify(st).includes('pw_hash'), false);

  r = await call('sarah', 'POST', '/api/login', { username: 'sArAhJ', password: 'TempPass2026' });
  assert.equal(r.status, 200); assert.equal(r.body.user.passwordRequiresChange, true);
  assert.equal((await call('sarah', 'POST', W + '/items/ideas', { upsert: [], remove: [] })).status, 403);
  assert.equal((await call('sarah', 'POST', '/api/change-password', { newPassword: 'SarahPass2026', confirmPassword: 'SarahPass2026' })).status, 200);

  r = await call('admin', 'POST', W + '/members', { firstName: 'John', lastName: 'Smith', username: 'JohnSmith', temporaryPassword: 'TempPass2026', role: 'Editor' });
  assert.equal(r.status, 201); const johnId = r.body.member.id;
  assert.equal((await call('john', 'POST', '/api/login', { username: 'JohnSmith', password: 'TempPass2026' })).status, 200);
  assert.equal((await call('john', 'POST', '/api/change-password', { newPassword: 'JohnPass2026', confirmPassword: 'JohnPass2026' })).status, 200);
  st = (await call('admin', 'GET', W)).body;
  const sarah = st.members.find(m => m.id === sarahId), john = st.members.find(m => m.id === johnId);

  r = await call('john', 'POST', W + '/items/ideas', { upsert: [{ id: 'i1', title: 'Sunday Worship Reel', status: 'Ideas', assigneeId: sarah.id, date: '2026-10-11' }], remove: [] }); assert.equal(r.status, 200);
  st = (await call('sarah', 'GET', W)).body; assert.equal(st.data.ideas[0].assignee, 'Sarah Johnson');
  r = await call('sarah', 'POST', W + '/items/ideas', { upsert: [{ ...st.data.ideas[0], status: 'Developing', assigneeId: john.id }], remove: [] }); assert.equal(r.status, 200);
  st = (await call('admin', 'GET', W)).body; assert.equal(st.data.ideas[0].status, 'Developing'); assert.equal(st.data.ideas[0].assignee, 'Sarah Johnson');
  assert.equal((await call('sarah', 'POST', W + '/items/ideas', { upsert: [], remove: ['i1'] })).status, 403);
  assert.equal((await call('sarah', 'POST', W + '/items/reminders', { upsert: [{ id: 'r1', title: 'x' }], remove: [] })).status, 403);
  assert.equal((await call('sarah', 'POST', W + '/members', {})).status, 403);

  r = await call('sarah', 'POST', W + '/comments', { targetKind: 'ideas', targetId: 'i1', text: 'On it' }); assert.equal(r.status, 201);
  assert.equal((await call('john', 'POST', W + '/comments', { targetKind: 'ideas', targetId: 'i1', parentId: r.body.id, text: 'Thanks' })).status, 201);
  st = (await call('admin', 'GET', W)).body; assert.equal(st.comments.length, 2);
  await call('john', 'POST', W + '/items/ideas', { upsert: [{ ...st.data.ideas[0], status: 'Approved' }], remove: [] });
  st = (await call('admin', 'GET', W)).body; assert.ok(st.activity.some(a => a.userName === 'John Smith' && a.text.startsWith('approved')));

  // Calendar events and analytics: persistence, validation and role enforcement.
  const ev = { id: 'e1', title: 'Sunday Reel', date: '2026-10-11', time: '09:30', platform: 'Instagram', format: 'Reel', status: 'Planned' };
  r = await call('john', 'POST', W + '/items/calendarEvents', { upsert: [ev], remove: [] }); assert.equal(r.status, 200);
  st = (await call('sarah', 'GET', W)).body; assert.equal(st.data.calendarEvents.length, 1); assert.equal(st.data.calendarEvents[0].caption, '');
  r = await call('john', 'POST', W + '/items/calendarEvents', { upsert: [{ ...ev, date: '2026-10-12', status: 'Published' }], remove: [] }); assert.equal(r.status, 200);
  st = (await call('admin', 'GET', W)).body; assert.equal(st.data.calendarEvents[0].date, '2026-10-12'); assert.equal(st.data.calendarEvents.length, 1);
  for (const bad of [{ title: '' }, { date: '2026-02-31' }, { date: 'soon' }, { time: '25:00' }, { status: 'Nope' }, { platform: 'MySpace' }, { format: 'Hologram' }])
    assert.equal((await call('john', 'POST', W + '/items/calendarEvents', { upsert: [{ ...ev, ...bad }], remove: [] })).status, 400, JSON.stringify(bad));
  assert.equal((await call('sarah', 'POST', W + '/items/calendarEvents', { upsert: [{ ...ev, id: 'e2' }], remove: [] })).status, 403);
  assert.equal((await call('sarah', 'POST', W + '/items/calendarEvents', { upsert: [], remove: ['e1'] })).status, 403);
  assert.equal((await call('sarah', 'POST', W + '/items/analytics', { upsert: [{ id: 'a1', title: 't', date: '2026-10-01' }], remove: [] })).status, 403);
  r = await call('john', 'POST', W + '/items/analytics', { upsert: [{ id: 'a1', title: 'Post', date: '2026-10-12', reach: 10, views: '', calendarEventId: 'e1' }], remove: [] }); assert.equal(r.status, 200);
  st = (await call('admin', 'GET', W)).body; assert.equal('views' in st.data.analytics[0], false); assert.equal(st.data.analytics[0].reach, 10);
  // Duplicate protection and deletion permissions at the API.
  assert.equal((await call('john', 'POST', W + '/items/analytics', { upsert: [{ id: 'a9', title: ' post ', date: '2026-10-12', reach: 1 }], remove: [] })).status, 409);
  assert.equal((await call('john', 'POST', W + '/items/analytics', { upsert: [{ id: 'b1', title: 'Dup', date: '2026-10-13' }, { id: 'b2', title: 'DUP', date: '2026-10-13' }], remove: [] })).status, 409);
  assert.equal((await call('admin', 'GET', W)).body.data.analytics.length, 1, 'rejected batch saved nothing');
  assert.equal((await call('john', 'POST', W + '/items/analytics', { upsert: [{ id: 'a1', title: 'Post', date: '2026-10-12', reach: 11 }], remove: [] })).status, 200);
  assert.equal((await call('sarah', 'POST', W + '/items/analytics', { upsert: [], remove: ['a1'] })).status, 403);
  assert.equal((await call('admin', 'GET', W)).body.data.analytics.length, 1);
  assert.equal((await call('john', 'POST', W + '/items/analytics', { upsert: [], remove: ['a1'] })).status, 200);
  assert.equal((await call('admin', 'GET', W)).body.data.analytics.length, 0);
  assert.equal((await call('john', 'POST', W + '/items/analytics', { upsert: [{ id: 'a1', title: 'Post', date: '2026-10-12', reach: 10 }], remove: [] })).status, 200, 'key is free again after deletion');
  assert.equal((await call('john', 'POST', W + '/items/analytics', { upsert: [{ id: 'a7', title: 'POST', date: '2026-10-12' }], remove: [] })).status, 409);
  for (const bad of [{ reach: 'abc' }, { reach: -1 }, { date: '2026-13-01' }])
    assert.equal((await call('john', 'POST', W + '/items/analytics', { upsert: [{ id: 'a2', title: 'x', ...bad }], remove: [] })).status, 400, JSON.stringify(bad));
  assert.equal((await call('john', 'POST', W + '/items/calendarEvents', { upsert: [], remove: ['e1'] })).status, 200);
  assert.equal((await call('admin', 'GET', W)).body.data.calendarEvents.length, 0);

  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(process.env.HOM_DB);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM users WHERE username='SarahJ' COLLATE NOCASE AND pw_hash='SarahPass2026'").get().c, 0);
  assert.equal(db.prepare('SELECT name FROM pragma_table_info(?)').all('users').some(c => c.name === 'email'), false);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM memberships WHERE workspace_id='house-of-mercy'").get().c, 3);
  assert.equal((await call('x', 'POST', '/api/login', { username: 'SarahJ', password: 'TempPass2026' })).status, 401);
  assert.equal((await call('sarah', 'POST', '/api/login', { username: 'SarahJ', password: 'SarahPass2026' })).status, 200);

  r = await call('admin', 'POST', `${W}/members/${sarahId}/reset-password`, { temporaryPassword: 'ResetPass2026' });
  assert.equal(r.status, 200); assert.equal(JSON.stringify(r.body).includes('ResetPass2026'), false);
  assert.equal((await call('sarah', 'GET', '/api/me')).status, 401);
  assert.equal((await call('sarah-old', 'POST', '/api/login', { username: 'SarahJ', password: 'SarahPass2026' })).status, 401);
  r = await call('sarah-reset', 'POST', '/api/login', { username: 'SarahJ', password: 'ResetPass2026' });
  assert.equal(r.status, 200); assert.equal(r.body.user.passwordRequiresChange, true);
  assert.equal((await call('sarah-reset', 'POST', '/api/change-password', { newPassword: 'SarahNewPass2026', confirmPassword: 'SarahNewPass2026' })).status, 200);

  const adminId = (await call('admin', 'GET', W)).body.members.find(m => m.username === 'HOMMediaAdmin').id;
  assert.equal((await call('admin', 'PATCH', W + '/members/' + adminId, { role: 'Editor' })).status, 409);
  assert.equal((await call('admin', 'PATCH', W + '/members/' + johnId, { role: 'Admin' })).status, 200);
  assert.equal((await call('admin', 'PATCH', `${W}/members/${johnId}/status`, { status: 'Suspended' })).status, 200);
  assert.equal((await call('john', 'GET', '/api/me')).status, 401);
  assert.equal((await call('admin', 'PATCH', `${W}/members/${johnId}/status`, { status: 'Active' })).status, 200);
  assert.equal((await call('admin', 'DELETE', W + '/members/' + sarahId)).status, 200);
  assert.equal((await call('sarah-reset', 'GET', W)).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users WHERE id=?').get(sarahId).c, 1);

  db.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('other','Other Church','x')").run();
  assert.equal((await call('admin', 'GET', '/api/w/other')).status, 404);
  assert.equal((await call('admin', 'POST', '/api/w/other/items/ideas', { upsert: [{ id: 'z', title: 'z' }], remove: [] })).status, 404);
  db.close();
  console.log('All tests passed'); server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
