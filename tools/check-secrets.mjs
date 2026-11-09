#!/usr/bin/env node
// The page only ever reads, so nothing that can write may reach it. This scans what would be deployed.
//   node tools/check-secrets.mjs [folders...]    default: dist public islands engine, tests skipped
//   node tools/check-secrets.mjs --self-test     proves that every pattern below still catches its fake key
// Exit code 1 when anything is found.

import { readdirSync, readFileSync, statSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { tmpdir } from 'node:os';

const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.json', '.html', '.css', '.txt', '.md', '.map', '.svg', '.xml', '.env', '.yml', '.yaml', '.toml', '']);
const SKIP_DIRS = new Set(['node_modules', 'test', 'references', '.git']);

const PATTERNS = [
  { name: 'Supabase secret key', re: /sb_secret_[A-Za-z0-9_-]{8,}/g },
  { name: 'the words service_role', re: /service_role/g },
  { name: 'write key assignment', re: /\b(write_?key|service_?key|service_?role_?key|secret_?key|api_?secret|SUPABASE_SERVICE[A-Z_]*)["']?\s*[:=]\s*["'`][^"'`\s]{6,}["'`]/gi },
  { name: 'database URL with a password', re: /\bpostgres(?:ql)?:\/\/[^\s:@/"']+:[^\s@/"']+@/g },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: 'OpenAI or OpenRouter style key', re: /\bsk-(?:or-v1-|proj-|ant-)?[A-Za-z0-9_-]{20,}/g },
  { name: 'xAI key', re: /\bxai-[A-Za-z0-9]{20,}/g },
  { name: 'Replicate key', re: /\br8_[A-Za-z0-9]{20,}/g },
  { name: 'Google key', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'GitHub token', re: /\bgh[pousr]_[A-Za-z0-9]{30,}/g },
  { name: 'AWS key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'ElevenLabs key', re: /\bsk_[a-f0-9]{40,}/g },
];

// Any non GET in the shipped bundle would break the rule that the page only reads.
const WRITE_CALLS = [
  { name: 'a POST, PUT, PATCH or DELETE request', re: /method\s*:\s*["'`](POST|PUT|PATCH|DELETE)["'`]/gi },
  { name: 'navigator.sendBeacon', re: /sendBeacon\s*\(/g },
];

const JWT = /\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;

function jwtRole(token) {
  try {
    const payload = token.split('.')[1];
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).role ?? 'none';
  } catch {
    return 'unreadable';
  }
}

export function scanText(text, { bundle = false } = {}) {
  const found = [];
  for (const { name, re } of [...PATTERNS, ...(bundle ? WRITE_CALLS : [])]) {
    re.lastIndex = 0;
    if (re.test(text)) found.push(name);
  }
  for (const token of text.match(JWT) ?? []) {
    const role = jwtRole(token);
    if (role !== 'anon') found.push(`a JWT with role "${role}"`);
  }
  return found;
}

// In the deploy folder nothing is skipped, so a reference image that slipped in gets seen.
function* walk(dir, isBundle) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) {
      if (isBundle || !SKIP_DIRS.has(entry)) yield* walk(path, isBundle);
    } else {
      yield { path, size: st.size };
    }
  }
}

export function scanFolders(folders) {
  const problems = [];
  let files = 0;
  for (const folder of folders) {
    if (!existsSync(folder)) continue;
    const isBundle = /(^|\/)dist\/?$/.test(folder);
    for (const { path, size } of walk(folder, isBundle)) {
      if (isBundle && /(^|\/)(references|blender)(\/|$)|\.blend\d?$/.test(path)) {
        problems.push({ path, found: ['a third party reference or source file in the deploy'] });
      }
      if (!TEXT_EXT.has(extname(path)) || size > 40 * 1024 * 1024) continue;
      files += 1;
      const found = scanText(readFileSync(path, 'utf8'), { bundle: isBundle });
      if (found.length) problems.push({ path, found });
    }
  }
  return { problems, files };
}

function selfTest() {
  // Built at run time so that this file holds no key shaped string of its own.
  const jwt = (role) => {
    const part = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'HS256' })}.${part({ role, iss: 'supabase' })}.c2lnbmF0dXJlLWJ5dGVz`;
  };
  const bad = {
    'service jwt': `const k="${jwt('service' + '_role')}"`,
    'authenticated jwt': `const k="${jwt('authenticated')}"`,
    'sb secret': `x=${'sb_' + 'secret_'}abcdefgh12345`,
    'the word': `role: "${'service' + '_role'}"`,
    'write key': `{"${'write' + '_key'}":"abcdef12345"}`,
    'service key env': `${'SUPABASE_SERVICE' + '_ROLE_KEY'}="abcdefgh"`,
    'db url': `${'postgres'}://user:${'hunter2'}@db.example.com/x`,
    'private key': `-----BEGIN ${'RSA PRIVATE'} KEY-----`,
    openai: `${'sk-'}abcdefghijklmnopqrstuvwx`,
    openrouter: `${'sk-or-v1-'}abcdefghijklmnopqrstuvwx`,
    xai: `${'xai-'}abcdefghijklmnopqrstuvwx`,
    replicate: `${'r8_'}abcdefghijklmnopqrstuvwx`,
    google: `${'AIza'}abcdefghijklmnopqrstuvwxyz123456`,
    github: `${'ghp_'}abcdefghijklmnopqrstuvwxyz1234567890`,
    aws: `${'AKIA'}ABCDEFGHIJKLMNOP`,
  };
  const failures = [];
  for (const [name, text] of Object.entries(bad)) {
    if (!scanText(text).length) failures.push(`missed: ${name}`);
  }
  const clean = [`const k="${jwt('anon')}"`, 'x=sb_publishable_abc123456', 'if (/^sb_secret_/i.test(key)) refuse();', 'const write_key = readSecret()', 'import * as THREE from "three"'];
  for (const text of clean) {
    if (scanText(text).length) failures.push(`false alarm: ${text}`);
  }
  if (!scanText('fetch(u,{method:"POST"})', { bundle: true }).length) failures.push('missed: POST in bundle');
  if (scanText('fetch(u,{method:"GET"})', { bundle: true }).length) failures.push('false alarm: GET in bundle');

  // And end to end, through the folder walk.
  const dir = mkdtempSync(join(tmpdir(), 'secrets-'));
  const dist = join(dir, 'dist');
  try {
    mkdirSync(join(dist, 'islands/x/references'), { recursive: true });
    writeFileSync(join(dist, 'a.js'), bad['service jwt']);
    writeFileSync(join(dist, 'islands/x/references/ref.jpg'), 'x');
    const out = scanFolders([dist]);
    if (out.problems.length !== 2) failures.push(`folder walk found ${out.problems.length} problems, expected 2`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return failures;
}

const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  if (args.includes('--self-test')) {
    const failures = selfTest();
    if (failures.length) {
      console.error(`Self test failed:\n  ${failures.join('\n  ')}`);
      process.exit(1);
    }
    console.log('Self test passed: every fake key was caught, the clean samples were left alone.');
    process.exit(0);
  }
  const folders = args.length ? args : ['dist', 'public', 'islands', 'engine', 'index.html'].filter(existsSync).filter((f) => statSync(f).isDirectory());
  const { problems, files } = scanFolders(folders);
  if (problems.length) {
    console.error('Possible secrets in what would ship:');
    for (const p of problems) console.error(`  ${relative(process.cwd(), p.path)}: ${p.found.join(', ')}`);
    process.exit(1);
  }
  console.log(`Clean: ${files} text files scanned in ${folders.join(', ')}. No write key, no service role key, no write call in the bundle, no reference images.`);
}
