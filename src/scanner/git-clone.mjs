import { execFileSync } from 'child_process';

// Branch names come from webhook payloads (PR authors control head.ref), so only
// allow a conservative subset of valid git ref names.
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;

export function isSafeBranchName(branch) {
  if (typeof branch !== 'string' || branch.length === 0 || branch.length > 255) return false;
  if (!BRANCH_RE.test(branch)) return false;
  if (branch.startsWith('-') || branch.startsWith('/') || branch.endsWith('/') || branch.endsWith('.')) return false;
  if (branch.includes('..') || branch.includes('//') || branch.endsWith('.lock')) return false;
  return true;
}

// Build a shell-free git clone invocation. The token is supplied as an HTTP auth
// header through GIT_CONFIG_* env vars (git >= 2.31), so it never appears in argv,
// the clone URL, or error messages, and is only sent to github.com.
export function buildCloneCommand({ cloneUrl, branch, cloneDir, token }) {
  if (!isSafeBranchName(branch)) throw new Error('Invalid branch name');

  const env = { ...process.env };
  if (token && cloneUrl.startsWith('https://github.com/')) {
    const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
    env.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }

  return {
    file: 'git',
    args: ['clone', '--depth', '1', '--branch', branch, '--', cloneUrl, cloneDir],
    env,
  };
}

export function cloneRepo(opts) {
  const { file, args, env } = buildCloneCommand(opts);
  try {
    execFileSync(file, args, { env, timeout: 60000, stdio: 'pipe' });
  } catch (err) {
    // Don't propagate git's stderr/command line; it can contain URLs and auth details.
    throw new Error(`git clone failed (exit ${err.status ?? 'unknown'})`);
  }
}

// Defense in depth for anything persisted or published (DynamoDB, logs, SNS).
export function redactSecrets(message, token) {
  let out = String(message ?? '');
  if (token) out = out.split(token).join('***');
  return out.replace(/(https?:\/\/)[^/\s@]+@/g, '$1***@');
}
