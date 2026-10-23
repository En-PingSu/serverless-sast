import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeBranchName, buildCloneCommand, redactSecrets } from '../../src/scanner/git-clone.mjs';

const TOKEN = 'ghs_exampletoken1234567890abcdef';

describe('isSafeBranchName()', () => {
  it('accepts ordinary branch names', () => {
    for (const b of ['main', 'feature/login-fix', 'release-1.2.3', 'user_name/wip']) {
      assert.equal(isSafeBranchName(b), true, b);
    }
  });

  it('rejects shell metacharacters and option-like names', () => {
    for (const b of ['a;id', 'x$(id)', 'x`id`', 'a|sh', 'a&b', '-upload-pack=x', '', 'a..b', 'a b', 'a.lock', undefined]) {
      assert.equal(isSafeBranchName(b), false, String(b));
    }
  });
});

describe('buildCloneCommand()', () => {
  it('passes the branch as a single argv element, never through a shell', () => {
    const { file, args } = buildCloneCommand({
      cloneUrl: 'https://github.com/o/r.git', branch: 'main', cloneDir: '/tmp/repo-1', token: TOKEN,
    });
    assert.equal(file, 'git');
    assert.deepEqual(args, ['clone', '--depth', '1', '--branch', 'main', '--', 'https://github.com/o/r.git', '/tmp/repo-1']);
  });

  it('keeps the token out of argv and supplies it as an auth header via env', () => {
    const { args, env } = buildCloneCommand({
      cloneUrl: 'https://github.com/o/r.git', branch: 'main', cloneDir: '/tmp/repo-1', token: TOKEN,
    });
    assert.ok(!args.join(' ').includes(TOKEN));
    assert.equal(env.GIT_CONFIG_KEY_0, 'http.https://github.com/.extraheader');
    const b64 = env.GIT_CONFIG_VALUE_0.replace('AUTHORIZATION: basic ', '');
    assert.equal(Buffer.from(b64, 'base64').toString(), `x-access-token:${TOKEN}`);
  });

  it('does not attach the token to non-GitHub hosts', () => {
    const { env } = buildCloneCommand({
      cloneUrl: 'https://evil.example/o/r.git', branch: 'main', cloneDir: '/tmp/repo-1', token: TOKEN,
    });
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
  });

  it('throws on an unsafe branch name', () => {
    assert.throws(() => buildCloneCommand({
      cloneUrl: 'https://github.com/o/r.git', branch: 'x;id', cloneDir: '/tmp/repo-1', token: TOKEN,
    }), /Invalid branch name/);
  });
});

describe('redactSecrets()', () => {
  it('removes the token and URL credentials from a message', () => {
    const msg = `Command failed: git clone https://x-access-token:${TOKEN}@github.com/o/r.git ${TOKEN}`;
    const out = redactSecrets(msg, TOKEN);
    assert.ok(!out.includes(TOKEN));
    assert.ok(out.includes('https://***@github.com/o/r.git'));
  });
});
