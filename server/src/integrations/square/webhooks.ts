import crypto from 'node:crypto';
import { timingSafeEqualStr } from '../../lib/crypto.js';

/**
 * Square webhook signature check (same algorithm as Square's official WebhooksHelper):
 * base64( HMAC-SHA256( signatureKey, notificationUrl + rawBody ) ) === x-square-hmacsha256-signature
 */
export function verifySquareSignature(rawBody: string, signature: string | undefined, signatureKey: string, notificationUrl: string) {
  if (!signature) return false;
  const expected = crypto.createHmac('sha256', signatureKey).update(notificationUrl + rawBody).digest('base64');
  return timingSafeEqualStr(expected, signature);
}
