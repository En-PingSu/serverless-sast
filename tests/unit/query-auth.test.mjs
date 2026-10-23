import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isAuthorized } from '../../src/query-api/auth.mjs';

const TOKEN = 'query-api-token-0123456789';

describe('isAuthorized()', () => {
  it('accepts the configured bearer token', () => {
    assert.equal(isAuthorized({ authorization: `Bearer ${TOKEN}` }, TOKEN), true);
  });

  it('rejects a missing, wrong or malformed token', () => {
    assert.equal(isAuthorized({}, TOKEN), false);
    assert.equal(isAuthorized({ authorization: 'Bearer wrong' }, TOKEN), false);
    assert.equal(isAuthorized({ authorization: TOKEN }, TOKEN), false);
    assert.equal(isAuthorized(undefined, TOKEN), false);
  });

  it('fails closed when no token is configured', () => {
    assert.equal(isAuthorized({ authorization: 'Bearer ' }, ''), false);
    assert.equal(isAuthorized({ authorization: 'Bearer anything' }, undefined), false);
  });
});
