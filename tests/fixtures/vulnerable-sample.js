// ============================================================
// Intentionally vulnerable code for SAST scanner testing
// Each section triggers one of the 11 detection rules
// ============================================================

import fs from 'fs';
import crypto from 'crypto';
import { exec, execSync } from 'child_process';

// --- RULE 1: HARDCODED_SECRET (HIGH) ---
const DB_PASSWORD = 'SuperSecret123!';
const api_key = 'AKIAIOSFODNN7EXAMPLE01234567';
const secret_key = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY0123456789ab';

// --- RULE 2: NOSQL_INJECTION (HIGH) ---
function unsafeQuery(req, db) {
  db.find(req.body);
  db.findOne(req.query);
  db.find({ $where: "this.isAdmin === true" });
}

// --- RULE 3: XSS (HIGH) ---
function renderUserContent(userInput) {
  document.getElementById('output').innerHTML = userInput;
  document.write(userInput);
  const el = document.createElement('div');
  el.insertAdjacentHTML('beforeend', userInput);
}

// --- RULE 4: PATH_TRAVERSAL (HIGH) ---
function readUserFile(req) {
  const data = fs.readFileSync(req.query.file);
  const config = '../../etc/passwd';
  return data;
}

// --- RULE 5: INSECURE_RANDOM (MEDIUM) ---
function generateToken() {
  const token = Math.random().toString(36).substring(2);
  return token;
}

// --- RULE 6: SENSITIVE_DATA_LOG (MEDIUM) ---
function loginUser(username, password) {
  console.log('Login attempt with password:', password);
  console.log('Using api_key token:', api_key);
}

// --- RULE 7: SQL_INJECTION (HIGH) ---
function getUser(db, userId) {
  db.query(`SELECT * FROM users WHERE id = ${userId}`);
  db.query('INSERT INTO logs VALUES (' + userId + ')');
}

// --- RULE 8: HARDCODED_IP (MEDIUM) ---
const DB_HOST = '192.168.1.100';
const API_SERVER = '10.0.0.50:8080';

// --- RULE 9: INSECURE_FUNCTION (HIGH) ---
function dangerousFunctions(userCode, cmd) {
  eval(userCode);
  execSync(cmd);
}

// --- RULE 10: SECURITY_TODO (LOW) ---
// TODO: fix security vulnerability in auth module
// HACK: bypassing authentication check for now

// --- RULE 11: WEAK_CRYPTO (MEDIUM) ---
function hashPassword(password) {
  const md5Hash = crypto.createHash('md5').update(password).digest('hex');
  const sha1Hash = crypto.createHash('sha1').update(password).digest('hex');
  return md5Hash;
}
