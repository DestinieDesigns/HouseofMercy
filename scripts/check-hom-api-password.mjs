import crypto from 'node:crypto'; import assert from 'node:assert';
import fs from 'node:fs';
const src=fs.readFileSync(''+new URL('../supabase',import.meta.url).pathname+'/functions/hom-api/index.ts','utf8');
const m=src.match(/const hashPassword[\s\S]*?\n\}\n/)[0].replace(/: string/g,'');
const h=src.match(/const hexToBytes[\s\S]*?\n\};\n/)[0].replace(/: string/g,'');
delete globalThis.Buffer; // simulate Deno
const f=new Function('crypto','return (()=>{'+m+'return {hashPassword,verifyPassword}})()')(crypto);
// stored hash produced by legacy format
const salt='00112233445566778899aabbccddeeff', hash=crypto.scryptSync('Media2026',salt,64).toString('hex');
assert(f.verifyPassword('Media2026',salt,hash)); assert(!f.verifyPassword('wrong',salt,hash));
assert(!f.verifyPassword('Media2026',salt,'')); assert(!f.verifyPassword('Media2026',salt,'zz'));
const n=f.hashPassword('abcdefgh'); assert(f.verifyPassword('abcdefgh',n.salt,n.hash)); console.log('ok');
