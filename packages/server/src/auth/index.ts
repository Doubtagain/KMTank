import { OAuth2Client } from 'google-auth-library';
import jwt from 'jsonwebtoken';

import { config } from '../config.js';
import { getStore, type GoogleProfile, type UserRecord } from '../db/store.js';

const googleClient = new OAuth2Client(config.googleClientId);

export interface SessionClaims {
  /** KMTank user id. */
  sub: string;
  name: string;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_token' | 'auth_required' | 'not_configured' = 'invalid_token',
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

/**
 * Verifies a Google Identity Services ID token and upserts the account.
 *
 * The token is checked against our own client id, so a token minted for some
 * other site cannot be replayed here.
 */
export async function loginWithGoogle(idToken: string): Promise<UserRecord> {
  if (!config.googleClientId) {
    throw new AuthError('Google sign-in is not configured on this server', 'not_configured');
  }
  if (!idToken || idToken.length > 4096) {
    throw new AuthError('Malformed credential');
  }

  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: config.googleClientId,
    });
    payload = ticket.getPayload();
  } catch {
    throw new AuthError('Google rejected the credential');
  }

  if (!payload?.sub) throw new AuthError('Credential has no subject');
  if (payload.email && payload.email_verified === false) {
    throw new AuthError('Google account email is not verified');
  }

  const profile: GoogleProfile = {
    sub: payload.sub,
    email: payload.email ?? null,
    name: sanitizeName(payload.name ?? payload.email?.split('@')[0] ?? 'Commander'),
    picture: payload.picture ?? null,
  };

  return getStore().upsertGoogleUser(profile);
}

export function issueSessionToken(user: UserRecord): string {
  const claims: SessionClaims = { sub: user.id, name: user.name };
  return jwt.sign(claims, config.jwtSecret, {
    expiresIn: config.jwtTtlSeconds,
    issuer: 'kmtank',
  });
}

export function verifySessionToken(token: string): SessionClaims {
  try {
    const decoded = jwt.verify(token, config.jwtSecret, { issuer: 'kmtank' });
    if (typeof decoded === 'string' || !decoded.sub) throw new Error('bad claims');
    return { sub: String(decoded.sub), name: String((decoded as jwt.JwtPayload).name ?? 'Player') };
  } catch {
    throw new AuthError('Session token is invalid or expired');
  }
}

/**
 * Codepoints that render as nothing, or that reorder the text around them.
 * Left in a display name they let one player impersonate another.
 */
function isHiddenCodePoint(cp: number): boolean {
  if (cp <= 0x1f) return true; // C0 controls
  if (cp >= 0x7f && cp <= 0x9f) return true; // DEL and C1 controls
  if (cp >= 0x200b && cp <= 0x200f) return true; // zero-width and LTR/RTL marks
  if (cp === 0x2028 || cp === 0x2029) return true; // line/paragraph separators
  if (cp >= 0x202a && cp <= 0x202e) return true; // bidi embedding overrides
  if (cp >= 0x2066 && cp <= 0x2069) return true; // bidi isolates
  if (cp === 0xfeff) return true; // zero-width no-break space
  return false;
}

/** Trims and strips deceptive characters from a user-supplied display name. */
export function sanitizeName(raw: string): string {
  let out = '';
  for (const char of raw) {
    const cp = char.codePointAt(0);
    if (cp === undefined || isHiddenCodePoint(cp)) continue;
    out += char;
  }
  const cleaned = out.replace(/\s+/g, ' ').trim().slice(0, 16);
  return cleaned.length > 0 ? cleaned : 'Player';
}
