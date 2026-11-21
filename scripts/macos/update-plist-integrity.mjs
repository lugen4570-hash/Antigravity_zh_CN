import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

/**
 * Computes the SHA-256 hex digest of an ASAR archive's unpadded header JSON bytes,
 * matching Electron's ElectronAsarIntegrity hash format.
 */
export function computeAsarHeaderSha256(asarPath) {
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
  return crypto.createHash('sha256').update(rawBuffer.subarray(16, 16 + jsonLen)).digest('hex');
}

/**
 * Updates ElectronAsarIntegrity hash for Resources/app.asar inside an XML Info.plist.
 */
export function updateXmlPlistIntegrity(plistText, newHash, entryKey = 'Resources/app.asar') {
  const integrityStart = plistText.indexOf('<key>ElectronAsarIntegrity</key>');
  if (integrityStart === -1) {
    return { updated: false, reason: 'no-integrity-key', plistText };
  }

  const escapedKey = entryKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(
    `(<key>${escapedKey}</key>\\s*<dict>[\\s\\S]*?<key>hash</key>\\s*<string>)([^<]+)(</string>)`,
  );
  if (!pattern.test(plistText)) {
    return { updated: false, reason: 'entry-not-found', plistText };
  }

  const nextText = plistText.replace(pattern, `$1${newHash}$3`);
  return {
    updated: nextText !== plistText,
    reason: nextText !== plistText ? 'updated' : 'already-matching',
    plistText: nextText,
  };
}

export function patchPlistIntegrityFile(plistPath, asarPath, options = {}) {
  if (!fs.existsSync(plistPath) || !fs.existsSync(asarPath)) {
    return { status: 'missing' };
  }
  const raw = fs.readFileSync(plistPath);
  if (raw.subarray(0, 6).toString('ascii') === 'bplist') {
    return { status: 'binary-plist-requires-plutil' };
  }

  const plistText = raw.toString('utf8');
  const hash = computeAsarHeaderSha256(asarPath);
  const res = updateXmlPlistIntegrity(plistText, hash, options.entryKey || 'Resources/app.asar');
  if (!res.updated) {
    return { status: res.reason, hash };
  }

  let backupCreated = false;
  if (options.backupPath && !fs.existsSync(options.backupPath)) {
    fs.mkdirSync(path.dirname(options.backupPath), { recursive: true });
    fs.copyFileSync(plistPath, options.backupPath);
    backupCreated = true;
  }

  fs.writeFileSync(plistPath, res.plistText, 'utf8');
  return { status: 'updated', hash, backupCreated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , plistPath, asarPath, ...rest] = process.argv;
  if (!plistPath || !asarPath) {
    console.error('Usage: node update-plist-integrity.mjs <plistPath> <asarPath> [--backup <path>]');
    process.exit(2);
  }
  let backupPath;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--backup' && rest[i + 1]) {
      backupPath = rest[i + 1];
      i += 1;
    }
  }
  console.log(JSON.stringify(patchPlistIntegrityFile(plistPath, asarPath, { backupPath })));
}
