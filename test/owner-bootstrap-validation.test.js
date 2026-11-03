import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidConfiguredAdminEmail, validateOwnerBootstrapInput } from '../scripts/owner-bootstrap-validation.js';

const validInput = {
  name: 'Edgar',
  email: 'owner@example.test',
  password: 'correct horse battery staple',
};

test('accepts a valid owner bootstrap input', () => {
  assert.deepEqual(validateOwnerBootstrapInput(validInput), []);
});

test('reports an empty or oversized owner name with safe reason codes', () => {
  assert.deepEqual(validateOwnerBootstrapInput({ ...validInput, name: '' }), ['OWNER_NAME_REQUIRED']);
  assert.deepEqual(validateOwnerBootstrapInput({ ...validInput, name: 'x'.repeat(161) }), ['OWNER_NAME_TOO_LONG']);
});

test('uses the project email format and maximum length checks', () => {
  assert.equal(isValidConfiguredAdminEmail('owner@example.test'), true);
  assert.equal(isValidConfiguredAdminEmail('invalid'), false);
  assert.equal(isValidConfiguredAdminEmail(`a@${'x'.repeat(250)}.test`), false);
  assert.deepEqual(validateOwnerBootstrapInput({ ...validInput, email: 'invalid' }), ['ADMIN_EMAIL_INVALID']);
});

test('counts password Unicode code points for the minimum length', () => {
  assert.deepEqual(validateOwnerBootstrapInput({ ...validInput, password: 'a'.repeat(11) }), ['PASSWORD_TOO_SHORT']);
  assert.deepEqual(validateOwnerBootstrapInput({ ...validInput, password: '😀'.repeat(12) }), []);
});

test('counts UTF-8 bytes for the maximum password length', () => {
  assert.deepEqual(validateOwnerBootstrapInput({ ...validInput, password: '😀'.repeat(65) }), ['PASSWORD_TOO_LONG_BYTES']);
});

test('can report multiple independent validation failures without echoing values', () => {
  assert.deepEqual(validateOwnerBootstrapInput({ name: '', email: 'invalid', password: 'short' }), [
    'OWNER_NAME_REQUIRED',
    'ADMIN_EMAIL_INVALID',
    'PASSWORD_TOO_SHORT',
  ]);
});
