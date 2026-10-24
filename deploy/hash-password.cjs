'use strict';

/*
 * Hashes an admin password for web-auth-proxy.auth.json.
 *
 * The password is read from DSH_NEW_PASSWORD (not from argv) so it does not
 * appear in the process list or shell history.  Usage:
 *
 *   $env:DSH_NEW_PASSWORD = '...'
 *   node hash-password.cjs admin
 */

const crypto = require('crypto');

const user = (process.argv[2] || 'admin').trim();
const password = process.env.DSH_NEW_PASSWORD || '';

if (!user) {
  console.error('hash-password: username must not be empty');
  process.exit(1);
}
if (password.length < 8) {
  console.error('hash-password: password must contain at least 8 characters');
  process.exit(1);
}

const salt = crypto.randomBytes(16);
const params = { N: 16384, r: 8, p: 1 };
const hash = crypto.scryptSync(password, salt, 32, params);

process.stdout.write(JSON.stringify({
  user,
  salt: salt.toString('base64url'),
  hash: hash.toString('base64url'),
  scrypt: params,
}, null, 2) + '\n');
