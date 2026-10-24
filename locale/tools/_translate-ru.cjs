'use strict';
const fs = require('fs');
const path = require('path');

const dictFile = path.join(__dirname, '_ru_dicts_en.json');
const cacheFile = path.join(__dirname, '_ru_cache.json');
const limit = Number(process.argv[2] || '0');

const dicts = JSON.parse(fs.readFileSync(dictFile, 'utf8'));
let cache = {};
try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { cache = {}; }

// Collect unique English strings.
const unique = new Map(); // text -> refs
for (const d of dicts) {
  for (const [key, value] of Object.entries(d.en)) {
    if (typeof value !== 'string') continue;
    if (!unique.has(value)) unique.set(value, []);
    unique.get(value).push(`${d.ns}/${key}`);
  }
}

function shouldTranslate(text) {
  if (!text || typeof text !== 'string') return false;
  if (text.length > 600) return false;
  if (/[\r\n]/.test(text)) return false;
  if (/\{\s*\w+\s*,\s*(plural|select|selectordinal)/i.test(text)) return false;
  if (!/[A-Za-z]/.test(text)) return false;
  return true;
}

const wanted = [...unique.keys()].filter(shouldTranslate);
const pending = wanted.filter((text) => !cache[text]);
console.log('unique strings:', unique.size, 'translatable:', wanted.length, 'pending:', pending.length);

const endpoint = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=ru&dt=t&q=';

function placeholders(text) {
  return (text.match(/\{[A-Za-z_][\w.]*\}/g) || []).sort();
}
function samePlaceholders(a, b) {
  const pa = placeholders(a), pb = placeholders(b);
  return pa.length === pb.length && pa.every((v, i) => v === pb[i]);
}

async function translateOnce(text) {
  const url = endpoint + encodeURIComponent(text);
  const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = await response.json();
  const parts = data?.[0];
  if (!Array.isArray(parts)) throw new Error('unexpected payload');
  const result = parts.map((part) => part[0] || '').join('');
  if (!result) throw new Error('empty translation');
  return result.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

async function translate(text) {
  const lead = (text.match(/^\s*/) || [''])[0];
  const trail = (text.match(/\s*$/) || [''])[0];
  const core = text.slice(lead.length, text.length - trail.length);

  const protectedCore = () => {
    const tokens = [];
    const masked = core.replace(/\{[A-Za-z_][\w.]*\}/g, (match) => {
      const token = `ZQX${tokens.length}QXZ`;
      tokens.push(match);
      return token;
    });
    return { masked, tokens };
  };

  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      let result;
      const first = await translateOnce(core);
      if (!samePlaceholders(core, first)) {
        const { masked, tokens } = protectedCore();
        const second = await translateOnce(masked);
        let missing = false;
        result = second.replace(/ZQX(\d+)QXZ/gi, (match, index) => {
          const token = tokens[Number(index)];
          if (token === undefined) { missing = true; return match; }
          return token;
        });
        if (missing) throw new Error('placeholder token lost');
        if (!samePlaceholders(core, result)) throw new Error('placeholders changed');
      } else {
        result = first;
      }
      if (result.trim() === '' && core.trim() !== '') throw new Error('blank result');
      return lead + result.trim() + trail;
    } catch (error) {
      if (attempt === 7) throw error;
      const wait = error.message.includes('429') ? Math.min(30000, 4000 * (attempt + 1)) : 800 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

let done = 0;
let failed = 0;
let cursor = 0;
const started = Date.now();

function saveCache() {
  const tmp = cacheFile + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cache, null, 0), 'utf8');
  fs.renameSync(tmp, cacheFile);
}

async function worker() {
  while (true) {
    const index = cursor++;
    if (index >= pending.length) return;
    if (limit > 0 && index >= limit) return;
    const text = pending[index];
    try {
      const ru = await translate(text);
      cache[text] = ru;
      done++;
    } catch (error) {
      failed++;
      if (failed <= 20) console.log('FAIL', JSON.stringify(text.slice(0, 80)), error.message);
    }
    await new Promise((r) => setTimeout(r, 150));
    if ((done + failed) % 25 === 0) {
      saveCache();
      const elapsed = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`progress ${done + failed}/${Math.min(pending.length, limit || pending.length)} ok=${done} fail=${failed} ${elapsed}s`);
    }
  }
}

(async () => {
  await Promise.all(Array.from({ length: 3 }, () => worker()));
  saveCache();
  console.log(`finished ok=${done} fail=${failed} total_cached=${Object.keys(cache).length}`);
})();
