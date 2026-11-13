import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const BOOTSTRAP_MARKER = '/* @antigravity-i18n-bootstrap */';
const BOOTSTRAP_END_MARKER = '/* @antigravity-i18n-bootstrap:end */';

export const DEFAULT_BOOTSTRAP_CODE = `'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');
try {
  const loaderPath = path.join(os.homedir(), '.antigravity-i18n', 'runtime', 'loader.js');
  if (fs.existsSync(loaderPath)) {
    const init = require(loaderPath);
    if (typeof init === 'function') {
      init(require('electron'));
    }
  }
} catch (err) {
  console.error('[antigravity-i18n] Failed to load runtime:', err);
}
`;

/**
 * Parses an Electron ASAR archive into its directory header tree and packed file buffers.
 */
export function readAsar(asarPath) {
  const rawBuffer = fs.readFileSync(asarPath);
  if (rawBuffer.length < 16) {
    throw new Error(`Invalid ASAR file (too small): ${asarPath}`);
  }
  const pickleSize = rawBuffer.readUInt32LE(4);
  const jsonLen = rawBuffer.readUInt32LE(12);
  const dataOffset = 8 + pickleSize;
  if (16 + jsonLen > dataOffset || dataOffset > rawBuffer.length) {
    throw new Error(`Corrupt ASAR header bounds in ${asarPath}`);
  }

  const header = JSON.parse(rawBuffer.subarray(16, 16 + jsonLen).toString('utf8'));
  const files = new Map();

  function collect(node, prefix) {
    if (!node || typeof node.files !== 'object') return;
    for (const [name, entry] of Object.entries(node.files)) {
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        collect(entry, relPath);
      } else if (!entry.unpacked && !entry.link && entry.offset !== undefined) {
        const start = dataOffset + Number(entry.offset);
        const end = start + Number(entry.size);
        if (end > rawBuffer.length) {
          throw new Error(`ASAR entry out of bounds: ${relPath}`);
        }
        files.set(relPath, Buffer.from(rawBuffer.subarray(start, end)));
      }
    }
  }

  collect(header, '');
  return { header, dataOffset, rawBuffer, files };
}

/**
 * Serializes header + fileBuffers back into a valid 4-byte-aligned ASAR file atomically.
 */
export function writeAsar(asarPath, header, fileBuffers) {
  const clonedHeader = structuredClone(header);
  const chunks = [];
  let offset = 0;

  function assignOffsets(node, prefix) {
    if (!node || typeof node.files !== 'object') return;
    for (const [name, entry] of Object.entries(node.files)) {
      const relPath = prefix ? `${prefix}/${name}` : name;
      if (entry.files) {
        assignOffsets(entry, relPath);
      } else if (!entry.unpacked && !entry.link) {
        const buf = fileBuffers.get(relPath);
        if (!buf) {
          throw new Error(`Missing buffer for packed ASAR entry: ${relPath}`);
        }
        entry.size = buf.length;
        entry.offset = String(offset);
        if (entry.integrity) {
          entry.integrity = computeIntegrity(buf, entry.integrity.blockSize || 4194304);
        }
        chunks.push(buf);
        offset += buf.length;
      }
    }
  }

  assignOffsets(clonedHeader, '');

  const jsonBuf = Buffer.from(JSON.stringify(clonedHeader), 'utf8');
  const alignedLen = (jsonBuf.length + 3) & ~3;
  const paddedJson = Buffer.alloc(alignedLen, 0);
  jsonBuf.copy(paddedJson);

  const pickleHeader = Buffer.alloc(16);
  pickleHeader.writeUInt32LE(4, 0);
  pickleHeader.writeUInt32LE(alignedLen + 8, 4);
  pickleHeader.writeUInt32LE(alignedLen + 4, 8);
  pickleHeader.writeUInt32LE(jsonBuf.length, 12);

  const outBuf = Buffer.concat([pickleHeader, paddedJson, ...chunks]);
  const tmpPath = `${asarPath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, outBuf);
  // Verify the written temp archive parses cleanly before replacing target
  readAsar(tmpPath);
  fs.renameSync(tmpPath, asarPath);
}

function computeIntegrity(buf, blockSize) {
  const blocks = [];
  for (let i = 0; i < buf.length; i += blockSize) {
    const slice = buf.subarray(i, Math.min(i + blockSize, buf.length));
    blocks.push(crypto.createHash('sha256').update(slice).digest('hex'));
  }
  return {
    algorithm: 'SHA256',
    hash: crypto.createHash('sha256').update(buf).digest('hex'),
    blockSize,
    blocks,
  };
}

function resolveEntryInfo(parsed) {
  let mainRel = 'dist/main.js';
  const pkgBuf = parsed.files.get('package.json');
  if (pkgBuf) {
    try {
      const pkg = JSON.parse(pkgBuf.toString('utf8'));
      if (typeof pkg.main === 'string' && pkg.main.trim()) {
        mainRel = pkg.main.replace(/^\.\//, '').replace(/\\/g, '/');
      }
    } catch {
      // Fallback to dist/main.js
    }
  }
  const dirPart = path.posix.dirname(mainRel);
  const bootstrapRel = dirPart === '.' ? 'zhBootstrap.js' : `${dirPart}/zhBootstrap.js`;
  return { mainRel, bootstrapRel };
}

function getHeaderNode(header, relPath, createMissing = false) {
  const parts = relPath.split('/');
  const fileName = parts.pop();
  let cur = header;
  for (const part of parts) {
    if (!cur.files) cur.files = {};
    if (!cur.files[part]) {
      if (!createMissing) return null;
      cur.files[part] = { files: {} };
    }
    cur = cur.files[part];
  }
  return { parent: cur, fileName };
}

function stripInjectedPrefix(mainContent) {
  if (!mainContent.startsWith(BOOTSTRAP_MARKER)) return mainContent;
  const endIdx = mainContent.indexOf(BOOTSTRAP_END_MARKER);
  if (endIdx === -1) return mainContent;
  let rest = mainContent.slice(endIdx + BOOTSTRAP_END_MARKER.length);
  if (rest.startsWith('\r\n')) rest = rest.slice(2);
  else if (rest.startsWith('\n')) rest = rest.slice(1);
  return rest;
}

export function isAsarPatched(asarPath) {
  if (!fs.existsSync(asarPath)) return false;
  const parsed = readAsar(asarPath);
  const { mainRel, bootstrapRel } = resolveEntryInfo(parsed);
  const mainBuf = parsed.files.get(mainRel);
  if (!mainBuf || !parsed.files.has(bootstrapRel)) return false;
  return mainBuf.toString('utf8').startsWith(BOOTSTRAP_MARKER);
}

export function patchAsar(asarPath, options = {}) {
  const parsed = readAsar(asarPath);
  const { mainRel, bootstrapRel } = resolveEntryInfo(parsed);
  const mainBuf = parsed.files.get(mainRel);
  if (!mainBuf) {
    throw new Error(`Entry script not found inside ASAR: ${mainRel}`);
  }

  const mainText = mainBuf.toString('utf8');
  if (mainText.startsWith(BOOTSTRAP_MARKER) && parsed.files.has(bootstrapRel)) {
    return { status: 'already-patched', backupCreated: false };
  }

  let backupCreated = false;
  if (options.backupPath && !fs.existsSync(options.backupPath)) {
    fs.mkdirSync(path.dirname(options.backupPath), { recursive: true });
    fs.copyFileSync(asarPath, options.backupPath);
    backupCreated = true;
  }

  const cleanMain = stripInjectedPrefix(mainText);
  const injectedSnippet = `${BOOTSTRAP_MARKER} try { require('./zhBootstrap'); } catch (_) {} ${BOOTSTRAP_END_MARKER}\n`;
  parsed.files.set(mainRel, Buffer.from(injectedSnippet + cleanMain, 'utf8'));

  const bootstrapCode = options.bootstrapCode || DEFAULT_BOOTSTRAP_CODE;
  parsed.files.set(bootstrapRel, Buffer.from(bootstrapCode, 'utf8'));

  const slot = getHeaderNode(parsed.header, bootstrapRel, true);
  slot.parent.files[slot.fileName] = { size: 0, offset: '0' };

  writeAsar(asarPath, parsed.header, parsed.files);
  return { status: 'patched', backupCreated };
}

export function unpatchAsar(asarPath) {
  const parsed = readAsar(asarPath);
  const { mainRel, bootstrapRel } = resolveEntryInfo(parsed);
  const mainBuf = parsed.files.get(mainRel);
  const hasBootstrap = parsed.files.has(bootstrapRel);
  const mainText = mainBuf ? mainBuf.toString('utf8') : '';
  const hasMarker = mainText.startsWith(BOOTSTRAP_MARKER);

  if (!hasBootstrap && !hasMarker) {
    return { status: 'not-patched' };
  }

  if (hasMarker) {
    parsed.files.set(mainRel, Buffer.from(stripInjectedPrefix(mainText), 'utf8'));
  }
  if (hasBootstrap) {
    parsed.files.delete(bootstrapRel);
    const slot = getHeaderNode(parsed.header, bootstrapRel, false);
    if (slot && slot.parent.files) {
      delete slot.parent.files[slot.fileName];
    }
  }

  writeAsar(asarPath, parsed.header, parsed.files);
  return { status: 'unpatched' };
}

function runCli() {
  const [, , cmd, asarPath, ...rest] = process.argv;
  if (!cmd || !asarPath) {
    console.error('Usage: node asar-patch.mjs <patch|unpatch|status> <asarPath> [--backup <path>]');
    process.exit(2);
  }
  let backupPath;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--backup' && rest[i + 1]) {
      backupPath = rest[i + 1];
      i++;
    }
  }
  if (cmd === 'status') {
    const patched = isAsarPatched(asarPath);
    console.log(JSON.stringify({ status: patched ? 'patched' : 'unpatched' }));
  } else if (cmd === 'patch') {
    const res = patchAsar(asarPath, { backupPath });
    console.log(JSON.stringify(res));
  } else if (cmd === 'unpatch') {
    const res = unpatchAsar(asarPath);
    console.log(JSON.stringify(res));
  } else {
    console.error(`Unknown command: ${cmd}`);
    process.exit(2);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCli();
}
