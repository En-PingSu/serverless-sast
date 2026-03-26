// ============================================================
// Clean code sample — should produce ZERO scanner findings
// Uses only safe patterns and best practices
// ============================================================

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

// Safe: secrets from environment variables
const dbPassword = process.env.DB_PASSWORD;
const apiKey = process.env.API_KEY;

// Safe: cryptographically secure random
function generateToken() {
  return crypto.randomUUID();
}

function generateSecureBytes() {
  return crypto.randomBytes(32).toString('hex');
}

// Safe: parameterized queries
function getUser(db, userId) {
  return db.query('SELECT * FROM users WHERE id = $1', [userId]);
}

// Safe: textContent instead of innerHTML
function renderText(element, text) {
  element.textContent = text;
}

// Safe: validated file path
function readFile(filename) {
  const safeName = path.basename(filename);
  const filePath = path.join('/app/data', safeName);
  return fs.readFileSync(filePath, 'utf-8');
}

// Safe: strong cryptography
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return crypto.createHash('sha256').update(salt + password).digest('hex');
}

// Safe: no sensitive data in logs
function loginUser(username) {
  console.log('Login attempt for user:', username);
}
