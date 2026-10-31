import assert from 'node:assert/strict';
import test from 'node:test';
import { createPasswordRecoveryMailer } from '../server/password-recovery-mail.js';

const smtpEnv = {
  SMTP_HOST: 'smtp.gmail.com',
  SMTP_PORT: '587',
  SMTP_USER: 'sender@example.invalid',
  SMTP_APP_PASSWORD: 'A'.repeat(16),
  EMAIL_FROM: 'sender@example.invalid',
};

test('password recovery uses a mocked Gmail SMTP transport with mandatory TLS', async () => {
  let transportOptions;
  let sentMessage;
  let closed = false;
  const send = createPasswordRecoveryMailer({
    env: smtpEnv,
    transportFactory(options) {
      transportOptions = options;
      return {
        async sendMail(message) { sentMessage = message; },
        close() { closed = true; },
      };
    },
  });

  await send('owner@example.invalid', '482731');
  assert.equal(transportOptions.host, 'smtp.gmail.com');
  assert.equal(transportOptions.secure, false);
  assert.equal(transportOptions.requireTLS, true);
  assert.equal(transportOptions.tls.minVersion, 'TLSv1.2');
  assert.equal(sentMessage.to, 'owner@example.invalid');
  assert.match(sentMessage.subject, /recuperar la contraseña/i);
  assert.match(sentMessage.text, /482731/);
  assert.doesNotMatch(sentMessage.text, /contraseña nueva/i);
  assert.equal(closed, true);
});

test('SMTP configuration rejects unsupported hosts, ports, or sender mismatch', async () => {
  const send = createPasswordRecoveryMailer({
    env: { ...smtpEnv, SMTP_HOST: 'smtp.invalid' },
    transportFactory() { throw new Error('transport must not be created'); },
  });
  await assert.rejects(send('owner@example.invalid', '123456'));
});
