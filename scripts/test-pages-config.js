'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const generator = path.join(__dirname, 'generate-pages-config.js');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'hom-pages-config-'));
const output = path.join(directory, 'config.js');

function generate(key) {
  fs.rmSync(output, { force: true });
  const env = { ...process.env, SUPABASE_PUBLISHABLE_KEY: key };
  return spawnSync(process.execPath, [generator, output], { encoding: 'utf8', env });
}

function token(role) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ role })).toString('base64url');
  return `${header}.${payload}.signature`;
}

try {
  let result = generate('');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUPABASE_PUBLISHABLE_KEY is required/);
  assert.match(result.stderr, /github-pages/);
  assert.equal(fs.existsSync(output), false);

  result = generate('sb_secret_never-publish');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Refusing to publish a Supabase secret key/);
  assert.equal(fs.existsSync(output), false);

  result = generate(token('service_role'));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /privileged Supabase key/);
  assert.equal(fs.existsSync(output), false);

  result = generate('not-a-supabase-key');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /must be a Supabase publishable key/);
  assert.equal(fs.existsSync(output), false);

  for (const key of ['sb_publishable_test-key', token('anon')]) {
    result = generate(key);
    assert.equal(result.status, 0, 'valid public keys should generate configuration');
    const window = {};
    vm.runInNewContext(fs.readFileSync(output, 'utf8'), { window });
    assert.equal(window.HOM_CONFIG.supabaseUrl, 'https://fsideooczwhfwgwxhhbb.supabase.co');
    assert.equal(window.HOM_CONFIG.supabasePublishableKey, key);
  }
  console.log('Pages configuration tests passed');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
