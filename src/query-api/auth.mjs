import crypto from 'crypto';

// The query API returns every scan record and pre-signed report URLs, so it
// requires the QueryApiToken as a bearer token. With no token configured,
// every request is refused.
export function isAuthorized(headers, expectedToken) {
  if (!expectedToken) return false;
  const header = headers?.authorization || headers?.Authorization || '';
  const match = /^Bearer\s+(\S+)$/.exec(header);
  if (!match) return false;
  const given = Buffer.from(match[1]);
  const expected = Buffer.from(expectedToken);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}
