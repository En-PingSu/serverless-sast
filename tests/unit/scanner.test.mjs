import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import { fileURLToPath } from 'url';
import { scanCode, scanFile, scanDirectory } from '../../src/scanner/scanner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, '..', 'fixtures');

// ============================================================
// scanCode() — one test per vulnerability rule
// ============================================================

describe('scanCode()', () => {

  it('detects HARDCODED_SECRET', () => {
    const code = `const password = 'SuperSecret123!';`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'HARDCODED_SECRET'), 'Should detect hardcoded password');
  });

  it('detects NOSQL_INJECTION', () => {
    const code = `db.find(req.body);`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'NOSQL_INJECTION'), 'Should detect NoSQL injection');
  });

  it('detects XSS', () => {
    const code = `element.innerHTML = userInput;`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'XSS'), 'Should detect XSS via innerHTML');
  });

  it('detects PATH_TRAVERSAL', () => {
    const code = `fs.readFileSync(req.query.file);`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'PATH_TRAVERSAL'), 'Should detect path traversal');
  });

  it('detects INSECURE_RANDOM', () => {
    const code = `const token = Math.random().toString(36);`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'INSECURE_RANDOM'), 'Should detect Math.random()');
  });

  it('detects SENSITIVE_DATA_LOG', () => {
    const code = `console.log('password:', password);`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'SENSITIVE_DATA_LOG'), 'Should detect sensitive data logging');
  });

  it('detects SQL_INJECTION', () => {
    const code = "db.query(`SELECT * FROM users WHERE id = ${userId}`);";
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'SQL_INJECTION'), 'Should detect SQL injection');
  });

  it('detects HARDCODED_IP', () => {
    const code = `const host = '192.168.1.100';`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'HARDCODED_IP'), 'Should detect hardcoded IP');
  });

  it('detects INSECURE_FUNCTION', () => {
    const code = `eval(userInput);`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'INSECURE_FUNCTION'), 'Should detect eval()');
  });

  it('detects SECURITY_TODO', () => {
    const code = `// TODO: fix security vulnerability`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'SECURITY_TODO'), 'Should detect security TODO');
  });

  it('detects WEAK_CRYPTO', () => {
    const code = `crypto.createHash('md5').update(data).digest('hex');`;
    const results = scanCode(code, 'test.js');
    assert.ok(results.some(r => r.id === 'WEAK_CRYPTO'), 'Should detect weak crypto');
  });

  it('returns empty array for clean code', () => {
    const code = `const x = 1;\nconst y = x + 2;\nconsole.log(y);`;
    const results = scanCode(code, 'test.js');
    assert.equal(results.length, 0, 'Clean code should have zero findings');
  });

  it('returns correct line numbers', () => {
    const code = `const a = 1;\nconst b = 2;\neval(userInput);`;
    const results = scanCode(code, 'test.js');
    const evalFinding = results.find(r => r.id === 'INSECURE_FUNCTION');
    assert.ok(evalFinding, 'Should find eval');
    assert.equal(evalFinding.line, 3, 'eval is on line 3');
  });

  it('sorts by severity: HIGH before MEDIUM before LOW', () => {
    const code = [
      `// TODO: fix security issue`,        // LOW
      `const token = Math.random();`,        // MEDIUM
      `eval(x);`,                            // HIGH
    ].join('\n');
    const results = scanCode(code, 'test.js');
    assert.ok(results.length >= 3, 'Should have at least 3 findings');

    const severities = results.map(r => r.severity);
    const highIdx = severities.indexOf('HIGH');
    const medIdx = severities.indexOf('MEDIUM');
    const lowIdx = severities.indexOf('LOW');
    if (highIdx !== -1 && medIdx !== -1) assert.ok(highIdx < medIdx, 'HIGH before MEDIUM');
    if (medIdx !== -1 && lowIdx !== -1) assert.ok(medIdx < lowIdx, 'MEDIUM before LOW');
  });

  it('truncates long evidence to 100 characters', () => {
    const longLine = `eval(${'x'.repeat(200)});`;
    const results = scanCode(longLine, 'test.js');
    const finding = results.find(r => r.id === 'INSECURE_FUNCTION');
    assert.ok(finding, 'Should find eval');
    assert.ok(finding.evidence.length <= 103, 'Evidence should be truncated (100 + "...")');
  });

  it('sets correct file name', () => {
    const code = `eval(x);`;
    const results = scanCode(code, 'myfile.js');
    assert.equal(results[0].file, 'myfile.js');
  });
});

// ============================================================
// scanFile()
// ============================================================

describe('scanFile()', () => {

  it('finds all 11 rule types in vulnerable-sample.js', () => {
    const filePath = path.join(fixturesDir, 'vulnerable-sample.js');
    const results = scanFile(filePath);
    const ruleIds = new Set(results.map(r => r.id));

    const expectedRules = [
      'HARDCODED_SECRET', 'NOSQL_INJECTION', 'XSS', 'PATH_TRAVERSAL',
      'INSECURE_RANDOM', 'SENSITIVE_DATA_LOG', 'SQL_INJECTION',
      'HARDCODED_IP', 'INSECURE_FUNCTION', 'SECURITY_TODO', 'WEAK_CRYPTO',
    ];

    for (const rule of expectedRules) {
      assert.ok(ruleIds.has(rule), `Should detect ${rule}`);
    }
  });

  it('finds zero vulnerabilities in clean-sample.js', () => {
    const filePath = path.join(fixturesDir, 'clean-sample.js');
    const results = scanFile(filePath);
    assert.equal(results.length, 0, `Expected 0 findings, got ${results.length}: ${results.map(r => r.id).join(', ')}`);
  });

  it('throws on non-existent file', () => {
    assert.throws(
      () => scanFile('/nonexistent/path/file.js'),
      /File not found/
    );
  });
});

// ============================================================
// scanDirectory()
// ============================================================

describe('scanDirectory()', () => {

  it('scans fixtures directory and finds results', () => {
    const results = scanDirectory(fixturesDir);
    const files = Object.keys(results);
    assert.ok(files.length > 0, 'Should find files with vulnerabilities');

    const hasVulnSample = files.some(f => f.includes('vulnerable-sample.js'));
    assert.ok(hasVulnSample, 'Should include vulnerable-sample.js');
  });

  it('throws on non-existent directory', () => {
    assert.throws(
      () => scanDirectory('/nonexistent/dir'),
      /Directory not found/
    );
  });

  it('respects file extension filter', () => {
    const results = scanDirectory(fixturesDir, ['.ts']);
    const files = Object.keys(results);
    assert.equal(files.length, 0, 'No .ts files in fixtures, should find nothing');
  });
});

// ============================================================
// Edge cases — document known false positives
// ============================================================

describe('edge cases (known scanner behavior)', () => {

  it('regex.exec() triggers INSECURE_FUNCTION (known false positive)', () => {
    const code = `const match = /test/.exec('hello');`;
    const results = scanCode(code, 'test.js');
    assert.ok(
      results.some(r => r.id === 'INSECURE_FUNCTION'),
      'regex.exec() is a known false positive for INSECURE_FUNCTION'
    );
  });

  it('relative paths trigger PATH_TRAVERSAL (known false positive)', () => {
    const code = `const p = '../../src/file.js';`;
    const results = scanCode(code, 'test.js');
    assert.ok(
      results.some(r => r.id === 'PATH_TRAVERSAL'),
      'Relative paths with ../ are a known false positive'
    );
  });

  it('localhost IP triggers HARDCODED_IP', () => {
    const code = `const host = '127.0.0.1';`;
    const results = scanCode(code, 'test.js');
    assert.ok(
      results.some(r => r.id === 'HARDCODED_IP'),
      'Localhost IP is detected as hardcoded IP'
    );
  });
});
