#!/usr/bin/env node
// Extract the built-in SyncTERM/CTerm bitmap fonts from the upstream C source
// (src/conio/allfonts.c) into a JSON asset.
//
// Upstream: SynchronetBBS/sbbs, src/conio/allfonts.c
// struct conio_font_data_struct {
//   char *eight_by_sixteen; char *eight_by_fourteen;
//   char *eight_by_eight;  char *twelve_by_twenty;
//   char *desc; enum ciolib_codepage cp; bool broken_bar;
// };
//
// This is a mechanical re-packaging of GPL'd upstream data. See docs/LICENSING.md.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SRC = process.argv[2] ?? '/tmp/opencode/ref/sbbs/src/conio/allfonts.c';
const OUT = process.argv[3] ?? resolve(import.meta.dirname, '../packages/render/assets/fonts/builtin-fonts.json');

const text = readFileSync(SRC, 'latin1');

const ARRAY_RE = /CIOLIBEXPORT\s+struct\s+conio_font_data_struct\s+conio_fontdata\s*\[\s*\d+\s*\]\s*=\s*\{/g;
// The file has two definitions: a NO_FONTS stub (no glyph data) and the real one.
// Take the last match, which carries the actual bitmap data.
let m = null;
for (const cand of text.matchAll(ARRAY_RE)) m = cand;
if (!m) throw new Error('conio_fontdata[] array not found in ' + SRC);

let i = m.index + m[0].length; // just after '{'

/** Decode a C string literal body (without surrounding quotes) into bytes. */
function decodeEscapes(body) {
  const out = [];
  for (let k = 0; k < body.length; k++) {
    const c = body[k];
    if (c !== '\\') {
      // latin1 source: charCodeAt is already the byte value
      out.push(body.charCodeAt(k) & 0xff);
      continue;
    }
    const n = body[++k];
    switch (n) {
      case 'x': {
        let hex = '';
        while (hex.length < 2 && /[0-9a-fA-F]/.test(body[k + 1] ?? '')) hex += body[++k];
        out.push(parseInt(hex, 16) & 0xff);
        break;
      }
      case '0': case '1': case '2': case '3':
      case '4': case '5': case '6': case '7': {
        let oct = n;
        while (oct.length < 3 && /[0-7]/.test(body[k + 1] ?? '')) oct += body[++k];
        out.push(parseInt(oct, 8) & 0xff);
        break;
      }
      case 'n': out.push(0x0a); break;
      case 't': out.push(0x09); break;
      case 'r': out.push(0x0d); break;
      case 'b': out.push(0x08); break;
      case 'f': out.push(0x0c); break;
      case 'v': out.push(0x0b); break;
      case 'a': out.push(0x07); break;
      case '\\': out.push(0x5c); break;
      case '"': out.push(0x22); break;
      case "'": out.push(0x27); break;
      case '?': out.push(0x3f); break;
      default: out.push(n.charCodeAt(0) & 0xff); break;
    }
  }
  return Buffer.from(out);
}


/** Skip whitespace AND C comments (the upstream array contains // comments). */
function skipWsAt(idx) {
  for (;;) {
    while (idx < text.length && /\s/.test(text[idx])) idx++;
    if (text[idx] === '/' && text[idx + 1] === '/') {
      while (idx < text.length && text[idx] !== '\n') idx++;
      continue;
    }
    if (text[idx] === '/' && text[idx + 1] === '*') {
      idx += 2;
      while (idx < text.length && !(text[idx] === '*' && text[idx + 1] === '/')) idx++;
      idx += 2;
      continue;
    }
    break;
  }
  return idx;
}

function skipWs() {
  for (;;) {
    while (i < text.length && /\s/.test(text[i])) i++;
    if (text[i] === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    break;
  }
}

/** Read a (possibly multi-part, implicitly concatenated) C string literal. */
function readString() {
  const parts = [];
  for (;;) {
    skipWs();
    if (text[i] !== '"') return null;
    i++;
    let body = '';
    while (i < text.length && text[i] !== '"') {
      if (text[i] === '\\') { body += text[i]; i++; body += text[i]; i++; }
      else { body += text[i]; i++; }
    }
    i++; // closing quote
    parts.push(decodeEscapes(body));
    // look ahead: skip whitespace/comments; if next is '"' it's an adjacent literal
    let j = skipWsAt(i);
    if (text[j] === '"') { i = j; continue; }
    return Buffer.concat(parts);
  }
}

const entries = [];

while (i < text.length) {
  skipWs();
  while (text[i] === ',') { i++; skipWs(); }
  if (text[i] === '}') break;
  if (text[i] !== '{') throw new Error('expected { at offset ' + i + ' got ' + JSON.stringify(text[i]));
  i++; // consume the entry's opening brace

  // Read 5 fields: 4 buffers + desc
  const fields = [];
  for (let f = 0; f < 5; f++) {
    skipWs();
    if (text[i] === 'N' && text.startsWith('NULL', i)) {
      i += 4; fields.push(null);
    } else if (text[i] === '"') {
      fields.push(readString());
    } else {
      throw new Error('unexpected field start at ' + i + ': ' + JSON.stringify(text.slice(i, i + 30)));
    }
    skipWs();
    if (text[i] === ',') { i++; continue; }
    break;
  }
  // Now enum + bool
  skipWs();
  let rest = text.slice(i);
  const enumMatch = /^([A-Z0-9_]+)/.exec(rest);
  if (!enumMatch) throw new Error('expected codepage enum at ' + i);
  const cp = enumMatch[1];
  i += enumMatch[1].length;
  skipWs();
  if (text[i] === ',') { i++; skipWs(); }
  let boolMatch = /^(true|false)/.exec(text.slice(i));
  if (!boolMatch) throw new Error('expected bool at ' + i);
  const brokenBar = boolMatch[1] === 'true';
  i += boolMatch[1].length;
  skipWs();
  if (text[i] === '}') i++;

  entries.push({
    eightBySixteen: fields[0] ? fields[0].toString('base64') : null,
    eightByFourteen: fields[1] ? fields[1].toString('base64') : null,
    eightByEight: fields[2] ? fields[2].toString('base64') : null,
    twelveByTwenty: fields[3] ? fields[3].toString('base64') : null,
    desc: fields[4] === null ? null : fields[4].toString('latin1'),
    cp,
    brokenBar,
  });
}

const byName = {};
for (const e of entries) {
  if (!e.desc) continue;
  byName[e.desc] = {
    '8x16': e.eightBySixteen,
    '8x14': e.eightByFourteen,
    '8x8': e.eightByEight,
    '12x20': e.twelveByTwenty,
    cp: e.cp,
    brokenBar: e.brokenBar,
  };
}

// Validate sizes: 8-wide fonts are 1 byte/row; the 12x20 font is 2 bytes/row.
const EXPECT = { '8x16': 256 * 16, '8x14': 256 * 14, '8x8': 256 * 8, '12x20': 256 * 20 * 2 };
let bad = 0;
for (const [name, f] of Object.entries(byName)) {
  for (const [k, expect] of Object.entries(EXPECT)) {
    if (!f[k]) continue;
    const len = Buffer.from(f[k], 'base64').length;
    if (len !== expect) { console.error(`WARN ${name} ${k}: ${len} bytes, expected ${expect}`); bad++; }
  }
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  source: 'SynchronetBBS/sbbs src/conio/allfonts.c',
  note: 'Bitmap fonts: 256 glyphs in codepage order, 1 byte per row, MSB = leftmost pixel.',
  fonts: byName,
}, null, 1));

console.error(`extracted ${entries.length} entries, ${Object.keys(byName).length} named fonts -> ${OUT}`);
if (bad) console.error(`${bad} size warnings`);
