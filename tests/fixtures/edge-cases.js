// ============================================================
// Edge cases — documents known scanner behavior
// Some patterns here ARE detected (known false positives)
// Tests assert these findings exist to document the behavior
// ============================================================

// KNOWN: regex.exec() triggers INSECURE_FUNCTION (false positive)
// The scanner matches bare `exec(` which catches regex.exec()
const match = /test/.exec('test string');

// KNOWN: relative import paths trigger PATH_TRAVERSAL (false positive)
// The scanner matches any string containing '../'
const importPath = '../../src/scanner/scanner.js';

// KNOWN: localhost IP triggers HARDCODED_IP (borderline)
const localhost = '127.0.0.1';

// NOT triggered: innerHTML with static string (quote follows =)
// The regex checks innerHTML = followed by non-quote character
const el = {};
el.innerHTML = '<b>static</b>';

// NOT triggered: password in variable name without assignment to string
let passwordLength = 12;
