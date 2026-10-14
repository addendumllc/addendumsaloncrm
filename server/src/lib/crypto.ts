import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * AES-256-GCM encryption for integration secrets stored in the database. Each value has its own random IV and an
 * authentication tag, so tampering is detected. Key rotation: set the new ENCRYPTION_KEY and the old one as
 * ENCRYPTION_KEY_PREVIOUS; values still readable only with the old key are re-encrypted at start-up (system/health.ts).
 */
const derive = (secret: string) => crypto.createHash('sha256').update(secret).digest();
function key(): Buffer {
  return derive(config().ENCRYPTION_KEY || 'dev-only-insecure-key-change-me-in-production');
}
function previousKey(): Buffer | null {
  const prev = config().ENCRYPTION_KEY_PREVIOUS?.trim();
  return prev ? derive(prev) : null;
}

/** A fingerprint of the current key (never the key): tells whether ENCRYPTION_KEY changed between starts. */
export const keyFingerprint = (secret = config().ENCRYPTION_KEY || 'dev-only-insecure-key-change-me-in-production') =>
  crypto.createHmac('sha256', secret).update('addendum-encryption-key-check').digest('hex').slice(0, 32);

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return [iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join('.');
}

function decryptWith(k: Buffer, payload: string): string {
  const [iv, tag, data] = payload.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** Decrypts with the current key, or the previous one during a key rotation. Throws if neither fits. */
export function decrypt(payload: string): string {
  try {
    return decryptWith(key(), payload);
  } catch (e) {
    const prev = previousKey();
    if (!prev) throw e;
    return decryptWith(prev, payload);
  }
}

/** True when the value opens with the current key (false: it needs re-encrypting, or the key was lost). */
export function decryptsWithCurrentKey(payload: string) {
  try {
    decryptWith(key(), payload);
    return true;
  } catch {
    return false;
  }
}

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
