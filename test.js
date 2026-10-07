'use strict';
// Integration test: node test.js (uses a temporary database).
const os = require('os'), path = require('path'), assert = require('assert');
process.env.HOM_DB = path.join(os.tmpdir(), `hom-test-${process.pid}.db`);
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
  let r = await call('admin', 'POST', '/api/register', { name: 'Admin Ann', email: 'ann@x.org', password: 'password123' }); assert.equal(r.status, 201);
  assert.equal((await call('uninvited', 'POST', '/api/register', { name: 'Eve', email: 'eve@x.org', password: 'password123' })).status, 403);
  r = await call('admin', 'POST', W + '/invitations', { email: 'sarah@x.org', role: 'Contributor' }); assert.equal(r.status, 201); const sarahTok = r.body.token;
  r = await call('admin', 'POST', W + '/invitations', { email: 'john@x.org', role: 'Editor' }); const johnTok = r.body.token;
  assert.equal((await call('sarah', 'POST', '/api/register', { name: 'Sarah', email: 'sarah@x.org', password: 'password123', inviteToken: johnTok })).status, 403);
  assert.equal((await call('sarah', 'POST', '/api/register', { name: 'Sarah', email: 'sarah@x.org', password: 'password123', inviteToken: sarahTok })).status, 201);
  assert.equal((await call('john', 'POST', '/api/register', { name: 'John', email: 'john@x.org', password: 'password123', inviteToken: johnTok })).status, 201);
  assert.equal((await call('sarah', 'POST', '/api/register', { name: 'Sarah', email: 'sarah@x.org', password: 'password123', inviteToken: sarahTok })).status, 409);
  let st = (await call('admin', 'GET', W)).body;
  assert.equal(st.members.length, 3); const sarah = st.members.find(m => m.name === 'Sarah'), john = st.members.find(m => m.name === 'John');
  assert.deepEqual(st.invitations.map(i => i.status), ['Accepted', 'Accepted']);
  // editor creates + assigns; everyone sees it
  r = await call('john', 'POST', W + '/items/ideas', { upsert: [{ id: 'i1', title: 'Sunday Worship Reel', status: 'Ideas', assigneeId: sarah.id, date: '2026-10-11' }], remove: [] }); assert.equal(r.status, 200);
  st = (await call('sarah', 'GET', W)).body; assert.equal(st.data.ideas[0].assignee, 'Sarah');
  // contributor: can update assigned work, cannot reassign / delete / write other collections / invite
  r = await call('sarah', 'POST', W + '/items/ideas', { upsert: [{ ...st.data.ideas[0], status: 'Developing', assigneeId: john.id }], remove: [] }); assert.equal(r.status, 200);
  st = (await call('admin', 'GET', W)).body; assert.equal(st.data.ideas[0].status, 'Developing'); assert.equal(st.data.ideas[0].assignee, 'Sarah');
  assert.equal((await call('sarah', 'POST', W + '/items/ideas', { upsert: [], remove: ['i1'] })).status, 403);
  assert.equal((await call('sarah', 'POST', W + '/items/reminders', { upsert: [{ id: 'r1', title: 'x' }], remove: [] })).status, 403);
  assert.equal((await call('sarah', 'POST', W + '/invitations', { email: 'a@b.co', role: 'Admin' })).status, 403);
  assert.equal((await call('sarah', 'PATCH', W + '/members/' + john.id, { role: 'Admin' })).status, 403);
  // comments + replies
  r = await call('sarah', 'POST', W + '/comments', { targetKind: 'ideas', targetId: 'i1', text: 'On it' }); assert.equal(r.status, 201);
  assert.equal((await call('john', 'POST', W + '/comments', { targetKind: 'ideas', targetId: 'i1', parentId: r.body.id, text: 'Thanks' })).status, 201);
  st = (await call('admin', 'GET', W)).body; assert.equal(st.comments.length, 2);
  // activity
  await call('john', 'POST', W + '/items/ideas', { upsert: [{ ...st.data.ideas[0], status: 'Approved' }], remove: [] });
  st = (await call('admin', 'GET', W)).body; assert.ok(st.activity.some(a => a.userName === 'John' && a.text.startsWith('approved')));
  // workspace isolation
  const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(process.env.HOM_DB);
  db.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('other','Other Church','x')").run();
  assert.equal((await call('admin', 'GET', '/api/w/other')).status, 404);
  assert.equal((await call('admin', 'POST', '/api/w/other/items/ideas', { upsert: [{ id: 'z', title: 'z' }], remove: [] })).status, 404);
  // last admin protected; roles change
  const ann = st.members.find(m => m.name === 'Admin Ann');
  assert.equal((await call('admin', 'PATCH', W + '/members/' + ann.id, { role: 'Editor' })).status, 409);
  assert.equal((await call('admin', 'PATCH', W + '/members/' + john.id, { role: 'Admin' })).status, 200);
  assert.equal((await call('admin', 'DELETE', W + '/members/' + sarah.id)).status, 200);
  assert.equal((await call('sarah', 'GET', W)).status, 404);
  assert.equal((await call('x', 'POST', '/api/login', { email: 'ann@x.org', password: 'wrong' })).status, 401);
  console.log('All tests passed'); server.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
