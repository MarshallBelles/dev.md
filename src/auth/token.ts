import { createHmac, timingSafeEqual } from 'node:crypto';

/** Issues and verifies compact HMAC-signed tokens (no external deps). */

export const createToken = (payload: Record<string, unknown>, secret: string): string => {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${sig}`;
};

export type TokenVerification =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: string };

export const verifyToken = (token: string, secret: string): TokenVerification => {
  const idx = token.lastIndexOf('.');
  if (idx === -1) return { ok: false, reason: 'malformed token' };
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = createHmac('sha256', secret).update(body).digest('base64url');
  if (expected.length !== sig.length) return { ok: false, reason: 'invalid signature' };
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) {
    return { ok: false, reason: 'invalid signature' };
  }
  try {
    return { ok: true, payload: JSON.parse(Buffer.from(body, 'base64url').toString('utf-8')) };
  } catch {
    return { ok: false, reason: 'invalid payload' };
  }
};
