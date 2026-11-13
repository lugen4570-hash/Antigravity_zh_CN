import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { readAsar } from '../patcher/asar-patch.mjs';

const ASAR_TEXT_RE = /['"`]([A-Z][A-Za-z0-9 ,.&'()\/:?!+\-@%]{2,180})['"`]/g;
const JSX_PROP_RE = /(?:children|label|title|subtitle|placeholder|aria-label|description|tooltip|heading|text|emptyText|buttonText|shortDescription|longDescription|displayName|confirmLabel|cancelLabel|submitLabel)\s*:\s*["']([A-Z][A-Za-z0-9 ,.&'()\/:?!+\-\u2026@%]{1,180})["']/g;
const JSX_CHILD_RE = /\.createElement\([^,]+,(?:null|\{[^}]{0,350}\}),["']([A-Z][A-Za-z0-9 ,.&'()\/:?!+\-\u2026@%]{1,180})["']/g;
const QUOTED_UI_RE = /["']([A-Z][a-z]+(?: [A-Za-z0-9,&'()\/+\-%@]{1,28}){0,18}[.?!\u2026:]?)["']/g;

function looksLikeUiLabel(str) {
  if (!str || str.length < 2 || str.length > 180) return false;
  if (/^[A-Z0-9_]+$/.test(str)) return false;
  if (/^[A-Z][a-z]+[A-Z][A-Za-z0-9]*$/.test(str)) return false;
  if (/^(https?|wss?|file|node_modules|application\/|text\/|image\/)/i.test(str)) return false;
  if (/[{}[\]$;=<>\\]/.test(str)) return false;
  if (str.includes('  ')) return false;
  return true;
}

/**
 * Reads an entry (e.g. 'main.js') from the ZIP archive embedded inside language_server.exe.
 */
export function readEmbeddedZipEntry(exePath, targetName) {
  if (!fs.existsSync(exePath)) return null;
  const buf = fs.readFileSync(exePath);
  const eocdSig = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  // Search backward from end for EOCD
  let eocdPos = buf.lastIndexOf(eocdSig);
  while (eocdPos !== -1) {
    if (eocdPos + 22 <= buf.length) {
      const cdSize = buf.readUInt32LE(eocdPos + 12);
      const cdOffsetInZip = buf.readUInt32LE(eocdPos + 16);
      const totalEntries = buf.readUInt16LE(eocdPos + 10);
      // Since ZIP is embedded inside an executable, compute zipBase from EOCD - cdSize - cdOffsetInZip
      const zipBase = eocdPos - cdSize - cdOffsetInZip;
      if (zipBase >= 0 && zipBase + cdOffsetInZip + cdSize === eocdPos && totalEntries > 0) {
        let p = zipBase + cdOffsetInZip;
        for (let i = 0; i < totalEntries && p + 46 <= eocdPos; i += 1) {
          if (buf.readUInt32LE(p) !== 0x02014b50) break;
          const compression = buf.readUInt16LE(p + 10);
          const compSize = buf.readUInt32LE(p + 20);
          const nameLen = buf.readUInt16LE(p + 28);
          const extraLen = buf.readUInt16LE(p + 30);
          const commentLen = buf.readUInt16LE(p + 32);
          const localHeaderOff = zipBase + buf.readUInt32LE(p + 42);
          const fileName = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
          if (fileName === targetName) {
            const lfhNameLen = buf.readUInt16LE(localHeaderOff + 26);
            const lfhExtraLen = buf.readUInt16LE(localHeaderOff + 28);
            const dataStart = localHeaderOff + 30 + lfhNameLen + lfhExtraLen;
            const rawSlice = buf.subarray(dataStart, dataStart + compSize);
            if (compression === 0) return rawSlice;
            if (compression === 8) return zlib.inflateRawSync(rawSlice);
            throw new Error(`Unsupported ZIP compression ${compression} for ${targetName}`);
          }
          p += 46 + nameLen + extraLen + commentLen;
        }
      }
    }
    eocdPos = buf.lastIndexOf(eocdSig, eocdPos - 1);
  }
  return null;
}

export function extractFromAsar(asarPath) {
  const results = new Set();
  if (!fs.existsSync(asarPath)) return [];
  const parsed = readAsar(asarPath);
  for (const [relPath, buf] of parsed.files.entries()) {
    if (!relPath.startsWith('dist/') || !relPath.endsWith('.js')) continue;
    const text = buf.toString('utf8');
    ASAR_TEXT_RE.lastIndex = 0;
    let m;
    while ((m = ASAR_TEXT_RE.exec(text)) !== null) {
      const s = m[1].trim();
      if (looksLikeUiLabel(s)) results.add(s);
    }
  }
  return [...results].sort();
}

export function extractFromLanguageServer(lsPath) {
  const results = new Set();
  const mainJsBuf = readEmbeddedZipEntry(lsPath, 'main.js');
  if (!mainJsBuf) return [];
  const text = mainJsBuf.toString('utf8');

  for (const re of [JSX_PROP_RE, JSX_CHILD_RE, QUOTED_UI_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      const s = m[1].trim();
      if (looksLikeUiLabel(s)) results.add(s);
    }
  }
  return [...results].sort();
}

export function extractAllUiStrings(asarPath, lsPath) {
  const asarStrings = extractFromAsar(asarPath);
  const lsStrings = extractFromLanguageServer(lsPath);
  return {
    asar: asarStrings,
    languageServer: lsStrings,
    combined: [...new Set([...asarStrings, ...lsStrings])].sort(),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const base = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'antigravity', 'resources');
  const asarPath = process.argv[2] || path.join(base, 'app.asar');
  const lsPath = process.argv[3] || path.join(base, 'bin', 'language_server.exe');
  const out = extractAllUiStrings(asarPath, lsPath);
  console.log(JSON.stringify(out, null, 2));
}
