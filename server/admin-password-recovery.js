import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { pool as defaultPool } from './db.js';
import { resolveClientIp } from './client-ip.js';
import { hashPassword as defaultHashPassword } from './passwords.js';
import {
  decryptAdminEmail,
  getEmailCryptoKeys,
  getRecoveryCodeKey,
  hashResetGrant,
  hmacRecoveryCode,
  hmacRecoveryIp,
  lookupAdminEmail,
  normalizeAdminEmail,
} from './admin-email-crypto.js';
import { sendPasswordRecoveryEmail as defaultSendEmail } from './password-recovery-mail.js';

const genericRequestMessage = 'Si el correo corresponde a una cuenta administrativa, recibirás un código si fue posible completar la solicitud.';
const invalidCodeMessage = 'El código no es válido o venció. Solicita uno nuevo e inténtalo otra vez.';
const resetCookieName = 'carpinteria_password_reset';
const accountRequestLimit = 3;
const ipRequestLimit = 10;
const globalRequestLimit = 20;
const codeAttemptLimit = 5;

function readCookie(request, name) {
  const prefix = `${name}=`;
  const cookie = (request.headers.cookie ?? '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : '';
}

function resetCookieOptions(maxAge) {
  const fields = [
    'Path=/api/admin/password-recovery',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === 'production') fields.push('Secure');
  return fields.join('; ');
}

function clearResetCookie(response) {
  response.append('Set-Cookie', `${resetCookieName}=; ${resetCookieOptions(0)}`);
}

function validHashEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string'
    || !/^[a-f0-9]{64}$/.test(left) || !/^[a-f0-9]{64}$/.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function recoveryRateKey(env) {
  const value = env.ADMIN_RATE_LIMIT_KEY ?? '';
  if (!/^[a-f0-9]{64,}$/i.test(value) || value.length % 2 !== 0) {
    throw new Error('ADMIN_RATE_LIMIT_KEY no está configurada.');
  }
  return Buffer.from(value, 'hex');
}

async function incrementRateBucket(client, scope, bucketHash, maxAttempts) {
  const { rows } = await client.query(`
    INSERT INTO admin_password_recovery_rate_limits
      (scope, bucket_hash, attempt_count, window_started_at, updated_at)
    VALUES ($1, $2, 1, now(), now())
    ON CONFLICT (scope, bucket_hash) DO UPDATE
    SET attempt_count = CASE
          WHEN admin_password_recovery_rate_limits.window_started_at <= now() - interval '15 minutes' THEN 1
          ELSE LEAST(admin_password_recovery_rate_limits.attempt_count + 1, $3 + 1)
        END,
        window_started_at = CASE
          WHEN admin_password_recovery_rate_limits.window_started_at <= now() - interval '15 minutes' THEN now()
          ELSE admin_password_recovery_rate_limits.window_started_at
        END,
        updated_at = now()
    RETURNING attempt_count
  `, [scope, bucketHash, maxAttempts]);
  return rows[0].attempt_count <= maxAttempts;
}

async function allowRecoveryAttempt(client, scope, emailHash, request, env, limits) {
  const clientIp = resolveClientIp(request, env);
  let clientBucketIdentity = clientIp;
  if (!clientBucketIdentity && env.RENDER === 'true' && env.RENDER_SERVICE_TYPE === 'web') {
    // Public and private Render requests share a listener, so forwarded IP
    // headers are forgeable from the private network. Use a stable service
    // bucket at the existing IP threshold instead of trusting those headers.
    clientBucketIdentity = `render-service:${scope}`;
  }
  if (!clientBucketIdentity) throw new Error('No se pudo determinar un origen seguro para el límite de intentos.');
  const ipHash = hmacRecoveryIp(clientBucketIdentity, recoveryRateKey(env));
  const globalHash = hmacRecoveryIp(`${scope}-global-recovery-limit`, getRecoveryCodeKey(env));
  await client.query("DELETE FROM admin_password_recovery_rate_limits WHERE updated_at < now() - interval '1 hour'");
  if (!(await incrementRateBucket(client, `${scope}-global`, globalHash, limits.global))) return false;
  const checks = await Promise.all([
    incrementRateBucket(client, `${scope}-account`, emailHash, limits.account),
    incrementRateBucket(client, `${scope}-ip`, ipHash, limits.ip),
  ]);
  return checks.every(Boolean);
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function adminEmailHash(env, lookupKey) {
  const email = normalizeAdminEmail(env.ADMIN_EMAIL);
  return email ? lookupAdminEmail(email, lookupKey) : null;
}

export function createAdminPasswordRecoveryHandlers({
  pool = defaultPool,
  sendEmail = defaultSendEmail,
  hashPassword = defaultHashPassword,
  env = process.env,
  logger = console,
} = {}) {
  async function requestCode(request, response) {
    response.set('Cache-Control', 'no-store');
    let pendingEmail = null;
    let pendingUserId = null;
    let pendingCodeHash = null;
    let pendingCode = null;

    try {
      const keys = getEmailCryptoKeys(env);
      const recoveryKey = getRecoveryCodeKey(env);
      const configuredAdminHash = adminEmailHash(env, keys.lookupKey);
      const suppliedEmail = typeof request.body?.email === 'string' ? request.body.email : '';
      const normalizedEmail = normalizeAdminEmail(suppliedEmail);
      const emailHash = lookupAdminEmail(normalizedEmail ?? 'invalid-recovery-request@example.invalid', keys.lookupKey);

      const allowed = await withTransaction(pool, async (client) => {
        const withinLimits = await allowRecoveryAttempt(client, 'request', emailHash, request, env, {
          account: accountRequestLimit, ip: ipRequestLimit, global: globalRequestLimit,
        });
        if (!withinLimits || !normalizedEmail || !configuredAdminHash) return false;

        const { rows } = await client.query(`
          SELECT id, email_ciphertext, email_nonce, email_auth_tag, email_lookup_hmac
          FROM users
          WHERE email_lookup_hmac = $1
            AND is_active = TRUE
            AND EXISTS (
              SELECT 1 FROM roles r WHERE r.id = users.role_id AND r.code = 'owner'
            )
          LIMIT 1
        `, [emailHash]);
        const user = rows[0];
        if (!user) {
          pendingEmail = (env.SMTP_USER ?? '').trim();
          pendingCode = String(randomInt(100_000, 1_000_000));
          return true;
        }

        pendingEmail = decryptAdminEmail(user, keys);
        pendingUserId = user.id;
        const code = String(randomInt(100_000, 1_000_000));
        pendingCodeHash = hmacRecoveryCode(user.id, code, recoveryKey);
        await client.query(`
          INSERT INTO admin_password_recoveries (
            user_id, purpose, code_hmac, expires_at, attempt_count,
            verified_at, reset_token_hash, reset_token_expires_at, consumed_at, requested_at
          ) VALUES ($1, 'password_reset', $2, now() + interval '10 minutes', 0, NULL, NULL, NULL, NULL, now())
          ON CONFLICT (user_id) DO UPDATE SET
            purpose = 'password_reset',
            code_hmac = EXCLUDED.code_hmac,
            expires_at = EXCLUDED.expires_at,
            attempt_count = 0,
            verified_at = NULL,
            reset_token_hash = NULL,
            reset_token_expires_at = NULL,
            consumed_at = NULL,
            requested_at = now()
        `, [user.id, pendingCodeHash]);
        pendingCode = code;
        return true;
      });

      if (allowed && pendingEmail && pendingCode) {
        try {
          await sendEmail(pendingEmail, pendingCode);
        } catch {
          logger.error('No se pudo enviar el correo de recuperación.');
          await pool.query(`
            UPDATE admin_password_recoveries
            SET code_hmac = NULL, consumed_at = now()
            WHERE user_id = $1 AND code_hmac = $2 AND verified_at IS NULL
          `, [pendingUserId, pendingCodeHash]).catch(() => {});
          return response.status(202).json({ message: genericRequestMessage });
        }
        return response.status(202).json({ message: genericRequestMessage });
      }
      return response.status(202).json({ message: genericRequestMessage });
    } catch {
      return response.status(503).json({ error: 'No fue posible procesar la solicitud de recuperación.' });
    }
  }

  async function verifyCode(request, response) {
    response.set('Cache-Control', 'no-store');
    const suppliedCode = typeof request.body?.code === 'string' ? request.body.code : '';
    let grantToken = null;
    try {
      const keys = getEmailCryptoKeys(env);
      const recoveryKey = getRecoveryCodeKey(env);
      const normalizedEmail = normalizeAdminEmail(request.body?.email);
      const configuredAdminHash = adminEmailHash(env, keys.lookupKey);
      if (!normalizedEmail || !configuredAdminHash) {
        return response.status(400).json({ error: invalidCodeMessage });
      }
      const emailHash = lookupAdminEmail(normalizedEmail, keys.lookupKey);
      if (emailHash !== configuredAdminHash) {
        return response.status(400).json({ error: invalidCodeMessage });
      }

      const verified = await withTransaction(pool, async (client) => {
        const withinLimits = await allowRecoveryAttempt(client, 'verify', emailHash, request, env, {
          account: 10, ip: 30, global: 400,
        });
        if (!withinLimits) return false;
        const { rows } = await client.query(`
          SELECT r.user_id, r.code_hmac, r.expires_at, r.attempt_count,
                 r.verified_at, r.consumed_at
          FROM admin_password_recoveries r
          JOIN users u ON u.id = r.user_id
          JOIN roles role ON role.id = u.role_id
          WHERE u.email_lookup_hmac = $1
            AND u.is_active = TRUE
            AND role.code = 'owner'
            AND r.purpose = 'password_reset'
          FOR UPDATE OF r
        `, [emailHash]);
        const recovery = rows[0];
        if (!recovery || !recovery.code_hmac || recovery.verified_at || recovery.consumed_at
          || new Date(recovery.expires_at).getTime() <= Date.now()
          || recovery.attempt_count >= codeAttemptLimit) return false;

        const candidate = hmacRecoveryCode(recovery.user_id,
          /^\d{6}$/.test(suppliedCode) ? suppliedCode : 'invalid-format', recoveryKey);
        const correct = validHashEqual(candidate, recovery.code_hmac);
        const nextAttempts = recovery.attempt_count + 1;
        if (!correct) {
          await client.query(`
            UPDATE admin_password_recoveries
            SET attempt_count = $2,
                code_hmac = CASE WHEN $2 >= $3 THEN NULL ELSE code_hmac END
            WHERE user_id = $1
          `, [recovery.user_id, nextAttempts, codeAttemptLimit]);
          return false;
        }

        grantToken = randomBytes(32).toString('hex');
        await client.query(`
          UPDATE admin_password_recoveries
          SET code_hmac = NULL,
              attempt_count = $2,
              verified_at = now(),
              reset_token_hash = $3,
              reset_token_expires_at = now() + interval '10 minutes'
          WHERE user_id = $1
        `, [recovery.user_id, nextAttempts, hashResetGrant(grantToken)]);
        return true;
      });

      if (!verified || !grantToken) return response.status(400).json({ error: invalidCodeMessage });
      response.append('Set-Cookie', `${resetCookieName}=${grantToken}; ${resetCookieOptions(600)}`);
      return response.json({ message: 'Código válido. Ya puedes establecer una contraseña nueva.' });
    } catch {
      return response.status(503).json({ error: 'No fue posible validar el código en este momento.' });
    }
  }

  async function completeReset(request, response) {
    response.set('Cache-Control', 'no-store');
    const token = readCookie(request, resetCookieName);
    const password = typeof request.body?.password === 'string' ? request.body.password : '';
    const confirmation = typeof request.body?.confirmation === 'string' ? request.body.confirmation : '';
    if (!/^[a-f0-9]{64}$/.test(token)) {
      clearResetCookie(response);
      return response.status(400).json({ error: 'La autorización de recuperación venció. Solicita un código nuevo.' });
    }
    const passwordBytes = Buffer.from(password);
    const confirmationBytes = Buffer.from(confirmation);
    if (Array.from(password).length < 12 || passwordBytes.length > 256
      || passwordBytes.length !== confirmationBytes.length
      || !timingSafeEqual(passwordBytes, confirmationBytes)) {
      return response.status(400).json({ error: 'La contraseña debe tener al menos 12 caracteres y ambas entradas deben coincidir.' });
    }

    const grantHash = hashResetGrant(token);
    try {
      const { rows: grantRows } = await pool.query(`
        SELECT user_id
        FROM admin_password_recoveries
        WHERE reset_token_hash = $1
          AND reset_token_expires_at > now()
          AND verified_at IS NOT NULL
          AND consumed_at IS NULL
      `, [grantHash]);
      if (!grantRows.length) {
        clearResetCookie(response);
        return response.status(400).json({ error: 'La autorización de recuperación venció. Solicita un código nuevo.' });
      }
      const passwordHash = await hashPassword(password);
      const keys = getEmailCryptoKeys(env);
      const configuredAdminHash = adminEmailHash(env, keys.lookupKey);
      const updated = await withTransaction(pool, async (client) => {
        const { rows } = await client.query(`
          SELECT r.user_id
          FROM admin_password_recoveries r
          JOIN users u ON u.id = r.user_id
          JOIN roles role ON role.id = u.role_id
          WHERE r.reset_token_hash = $1
            AND r.reset_token_expires_at > now()
            AND r.verified_at IS NOT NULL
            AND r.consumed_at IS NULL
            AND u.email_lookup_hmac = $2
            AND u.is_active = TRUE
            AND role.code = 'owner'
          FOR UPDATE OF r
        `, [grantHash, configuredAdminHash]);
        const recovery = rows[0];
        if (!recovery) return false;
        const result = await client.query(`
          UPDATE users SET password_hash = $2, updated_at = now()
          WHERE id = $1 AND is_active = TRUE
        `, [recovery.user_id, passwordHash]);
        if (result.rowCount !== 1) return false;
        await client.query('DELETE FROM admin_sessions WHERE user_id = $1', [recovery.user_id]);
        await client.query(`
          UPDATE admin_password_recoveries
          SET code_hmac = NULL, reset_token_hash = NULL, reset_token_expires_at = NULL,
              consumed_at = now()
          WHERE user_id = $1
        `, [recovery.user_id]);
        await client.query(`
          INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, result)
          VALUES ($1, 'admin.password.recovered', 'authentication', $1, 'success')
        `, [recovery.user_id]);
        return true;
      });
      clearResetCookie(response);
      if (!updated) return response.status(400).json({ error: 'La autorización de recuperación venció. Solicita un código nuevo.' });
      return response.json({ message: 'La contraseña se actualizó. Inicia sesión con la nueva contraseña.' });
    } catch {
      clearResetCookie(response);
      return response.status(503).json({ error: 'No fue posible actualizar la contraseña en este momento.' });
    }
  }

  return { requestCode, verifyCode, completeReset };
}

export const adminPasswordRecoveryHandlers = createAdminPasswordRecoveryHandlers();
