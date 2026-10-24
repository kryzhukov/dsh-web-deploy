'use strict';
const fs = require('fs');
const path = require('path');

function findPackageRoot() {
  const localBase = path.join(process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local'), 'npm-cache', '_npx');
  const candidates = [];
  if (fs.existsSync(localBase)) {
    for (const hash of fs.readdirSync(localBase)) {
      const dir = path.join(localBase, hash, 'node_modules', '@deepseek-ai');
      if (fs.existsSync(path.join(dir, 'dsh-client-locale'))) candidates.push(dir);
    }
  }
  const globalDir = path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai');
  if (fs.existsSync(path.join(globalDir, 'dsh-client-locale'))) candidates.push(globalDir);
  if (candidates.length === 0) throw new Error('cannot find an installed @deepseek-ai/dsh package');
  candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return candidates[0];
}

const root = findPackageRoot();
const outFile = path.join(__dirname, '_ru_dicts_en.json');

function extractObject(src, start) {
  let depth = 0, i = start, str = null, esc = false;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (str) {
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === str) str = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { str = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  return null;
}

function extractLiteral(src, name) {
  const re = new RegExp('const ' + name.replace(/\$/g, '\\$') + '\\s*=\\s*');
  const m = re.exec(src);
  if (!m) return undefined;
  const start = m.index + m[0].length;
  if (src[start] === '{') {
    const text = extractObject(src, start);
    return text === null ? undefined : (0, eval)('(' + text + ')');
  }
  if (src[start] === '"' || src[start] === "'" || src[start] === '`') {
    const quote = src[start];
    let i = start + 1;
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === quote) { i++; break; }
      i++;
    }
    const raw = src.slice(start, i);
    try { return (0, eval)('(' + raw + ')'); } catch { return undefined; }
  }
  return undefined;
}

function resolveIdentifiers(objText, src) {
  let text = objText;
  text = text.replace(/\.\.\.([A-Za-z_$][\w$]*)/g, (full, name) => {
    const value = extractLiteral(src, name);
    if (value === undefined || typeof value !== 'object') return full;
    return '...' + JSON.stringify(value);
  });
  text = text.replace(/:\s*([A-Za-z_$][\w$]*)\s*([,}])/g, (full, name, tail) => {
    if (['true', 'false', 'null', 'undefined'].includes(name)) return full;
    const value = extractLiteral(src, name);
    if (value === undefined) return full;
    return ': ' + JSON.stringify(value) + tail;
  });
  return text;
}

function resolveNamespace(src, arg) {
  arg = arg.trim();
  if (/^["'`]/.test(arg)) return arg.slice(1, -1);
  if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
    const m = new RegExp('const ' + arg.replace(/\$/g, '\\$') + '\\s*=\\s*["\'`]([^"\'`]+)["\'`]').exec(src);
    if (m) return m[1];
  }
  return null;
}

const merged = new Map();
for (const pkg of fs.readdirSync(root)) {
  if (!pkg.startsWith('dsh-client-')) continue;
  const file = path.join(root, pkg, 'lib', 'client.js');
  if (!fs.existsSync(file)) continue;
  const src = fs.readFileSync(file, 'utf8');

  // Collect register calls: locale.register(ARG, { ... en ... zh ... })
  const callRe = /locale\.register\(([^,]+),\s*\{([^{}]*)\}\)/g;
  let match;
  while ((match = callRe.exec(src)) !== null) {
    const ns = resolveNamespace(src, match[1]);
    const body = match[2];
    const enMatch = /(?:^|,)\s*en(?::\s*([A-Za-z0-9_$]+))?\s*(?=,|$)/.exec(body);
    if (!enMatch) { console.log('NO EN', pkg, match[1].trim()); continue; }
    const enVar = enMatch[1] || 'en';
    if (!ns) { console.log('UNRESOLVED NS', pkg, match[1]); continue; }
    const dictAt = src.indexOf('const ' + enVar + ' = {');
    if (dictAt < 0) { console.log('MISSING DICT', pkg, ns, enVar); continue; }
    const objTextRaw = extractObject(src, src.indexOf('{', dictAt));
    if (!objTextRaw) { console.log('BAD DICT', pkg, ns, enVar); continue; }
    const objText = resolveIdentifiers(objTextRaw, src);
    let en;
    try { en = (0, eval)('(' + objText + ')'); } catch (e) { console.log('EVAL FAIL', pkg, ns, enVar, e.message); continue; }

    if (!merged.has(ns)) merged.set(ns, { ns, packages: [], en: {} });
    const target = merged.get(ns);
    if (!target.packages.includes(pkg)) target.packages.push(pkg);
    for (const [k, v] of Object.entries(en)) {
      if (target.en[k] !== undefined && target.en[k] !== v) console.log('CONFLICT', ns, k, JSON.stringify(target.en[k]), JSON.stringify(v));
      target.en[k] = v;
    }
  }
}

const dicts = [...merged.values()].sort((a, b) => a.ns.localeCompare(b.ns));
let total = 0;
for (const d of dicts) {
  total += Object.keys(d.en).length;
  console.log(`${d.ns}\t${Object.keys(d.en).length}\t${d.packages.join(',')}`);
}
console.log('namespaces', dicts.length, 'keys', total);
fs.writeFileSync(outFile, JSON.stringify(dicts, null, 2), 'utf8');
console.log('wrote', outFile);
