'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PROJECT_URL = 'https://fsideooczwhfwgwxhhbb.supabase.co';
const SETTINGS = 'Settings > Secrets and variables > Actions, or Settings > Environments > github-pages';

function fail(message) {
  console.error(`::error::${message}`);
  process.exit(1);
}

const key = (process.env.SUPABASE_PUBLISHABLE_KEY || '').trim();
if (!key) {
  fail(`SUPABASE_PUBLISHABLE_KEY is required. Add the real Supabase publishable key as a variable or secret in ${SETTINGS}.`);
}

if (key.startsWith('sb_secret_')) {
  fail('Refusing to publish a Supabase secret key; SUPABASE_PUBLISHABLE_KEY must be a public publishable key.');
}

if (key.startsWith('sb_publishable_')) {
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(key)) {
    fail('SUPABASE_PUBLISHABLE_KEY is malformed; provide the publishable key from Supabase API settings.');
  }
} else {
  const parts = key.split('.');
  let role = '';
  try {
    if (parts.length === 3) role = JSON.parse(Buffer.from(parts[1], 'base64url').toString()).role || '';
  } catch {
    role = '';
  }
  if (role === 'service_role' || role === 'supabase_admin') {
    fail('Refusing to publish a privileged Supabase key; use the project publishable key instead.');
  }
  if (role !== 'anon') {
    fail('SUPABASE_PUBLISHABLE_KEY must be a Supabase publishable key (sb_publishable_...) or legacy anon key.');
  }
}

const outputPath = process.argv[2];
if (!outputPath) fail('Usage: node scripts/generate-pages-config.js <output-path>');

fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
fs.writeFileSync(
  outputPath,
  `window.HOM_CONFIG = ${JSON.stringify({ supabaseUrl: PROJECT_URL, supabasePublishableKey: key })};\n`,
);
