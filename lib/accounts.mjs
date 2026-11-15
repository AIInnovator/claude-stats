// Which Claude account ran a session, as a short key the page can group by. The raw account and organization ids
// (from session-owner lines and .claude.json) stay in the server; only the key is sent.
import fs from 'node:fs';
import { createHash } from 'node:crypto';

const keys = new Map(); // "account:org" -> key; a handful of accounts per machine

/** First 12 hex chars of SHA-256 of "accountUuid:organizationUuid": stable across restarts, not reversible. */
export function accountKey(accountUuid, organizationUuid) {
  const raw = accountUuid + ':' + organizationUuid;
  let k = keys.get(raw);
  if (!k) { k = createHash('sha256').update(raw).digest('hex').slice(0, 12); keys.set(raw, k); }
  return k;
}

/** Key of a session-owner line or an oauthAccount; '' without an account id. One rule, so a login matches its sessions. */
export const keyOf = (o) => (typeof o?.accountUuid === 'string' && o.accountUuid
  ? accountKey(o.accountUuid, typeof o.organizationUuid === 'string' ? o.organizationUuid : '') : '');

/**
 * The login saved in a .claude.json: { email, org, type, tier, key, extra? }, or null when logged out (or API key).
 * Throws on a file caught mid-write. Only these fields leave: ids, tokens and every other setting stay here.
 */
export function readLogin(file) {
  const u = JSON.parse(fs.readFileSync(file, 'utf8')).oauthAccount;
  if (!u || typeof u !== 'object') return null;
  return {
    email: u.emailAddress || '', org: u.organizationName || '', type: u.organizationType || '', tier: u.userRateLimitTier || '', key: keyOf(u),
    ...(typeof u.hasExtraUsageEnabled === 'boolean' && { extra: u.hasExtraUsageEnabled }),
  };
}
