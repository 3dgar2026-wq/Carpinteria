import { createHash, createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { pool, query } from './db.js';
import { passwordParameters, verifyPassword } from './passwords.js';
import { adminPasswordRecoveryHandlers } from './admin-password-recovery.js';
import {
  decryptAdminEmail,
  getEmailCryptoKeys,
  lookupAdminEmail,
} from './admin-email-crypto.js';

const scrypt = promisify(scryptCallback);
const sourceDirectory = path.dirname(fileURLToPath(import.meta.url));
const loginPagePath = path.resolve(sourceDirectory, '..', 'server', 'views', 'admin-login.html');
const recoveryPagePath = path.resolve(sourceDirectory, '..', 'server', 'views', 'admin-recovery.html');
const adminPagePath = path.resolve(sourceDirectory, '..', 'public', 'admin', 'index.html');
const sessionCookieName = 'carpinteria_admin_session';
const loginCsrfCookieName = 'carpinteria_admin_login_csrf';
const sessionDurationSeconds = 8 * 60 * 60;
const loginWindowMs = 15 * 60 * 1000;
const loginAttemptLimit = 5;
const configuredAdminEmail = (process.env.ADMIN_EMAIL ?? '').trim().toLowerCase();
const adminEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(configuredAdminEmail)
  && configuredAdminEmail.length <= 254
  ? configuredAdminEmail
  : null;
const configuredRateKey = process.env.ADMIN_RATE_LIMIT_KEY ?? '';
const rateLimitKey = /^[0-9a-fA-F]{64,}$/.test(configuredRateKey) && configuredRateKey.length % 2 === 0
  ? Buffer.from(configuredRateKey, 'hex')
  : null;

export class AdminInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function readCookie(request, name) {
  const prefix = `${name}=`;
  const parts = (request.headers.cookie ?? '').split(';');
  const cookie = parts.map((part) => part.trim()).find((part) => part.startsWith(prefix));
  return cookie ? cookie.slice(prefix.length) : '';
}

function cookieOptions(maxAge, pathValue = '/') {
  const fields = [
    `Path=${pathValue}`,
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAge}`,
  ];
  if (process.env.NODE_ENV === 'production') fields.push('Secure');
  return fields.join('; ');
}

function clearCookie(response, name, pathValue = '/') {
  response.append('Set-Cookie', `${name}=; ${cookieOptions(0, pathValue)}`);
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function getRateBucket(request) {
  if (!rateLimitKey) return null;
  const address = request.socket.remoteAddress ?? 'unknown';
  return createHmac('sha256', rateLimitKey).update(address).digest('hex');
}

async function allowLoginAttempt(bucketHash) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("DELETE FROM admin_login_attempts WHERE updated_at < now() - interval '1 day'");
    await client.query(`
      INSERT INTO admin_login_attempts (bucket_hash, attempt_count)
      VALUES ($1, 0)
      ON CONFLICT (bucket_hash) DO NOTHING
    `, [bucketHash]);
    const { rows } = await client.query(`
      SELECT attempt_count, window_started_at, blocked_until
      FROM admin_login_attempts
      WHERE bucket_hash = $1
      FOR UPDATE
    `, [bucketHash]);
    const attempt = rows[0];
    const now = Date.now();

    if (attempt.blocked_until && new Date(attempt.blocked_until).getTime() > now) {
      await client.query('COMMIT');
      return false;
    }

    const expiredWindow = now - new Date(attempt.window_started_at).getTime() >= loginWindowMs;
    if (expiredWindow) {
      await client.query(`
        UPDATE admin_login_attempts
        SET attempt_count = 1, window_started_at = now(), blocked_until = NULL, updated_at = now()
        WHERE bucket_hash = $1
      `, [bucketHash]);
      await client.query('COMMIT');
      return true;
    }

    if (attempt.attempt_count >= loginAttemptLimit) {
      await client.query(`
        UPDATE admin_login_attempts
        SET blocked_until = window_started_at + interval '15 minutes', updated_at = now()
        WHERE bucket_hash = $1
      `, [bucketHash]);
      await client.query('COMMIT');
      return false;
    }

    await client.query(`
      UPDATE admin_login_attempts
      SET attempt_count = attempt_count + 1, updated_at = now()
      WHERE bucket_hash = $1
    `, [bucketHash]);
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

async function renderLogin(response, status, message) {
  const token = randomBytes(32).toString('hex');
  const template = await readFile(loginPagePath, 'utf8');
  response.append('Set-Cookie', `${loginCsrfCookieName}=${token}; ${cookieOptions(600, '/admin/login')}`);
  response.set('Cache-Control', 'no-store');
  response.status(status).type('html').send(template
    .replaceAll('@@LOGIN_CSRF_TOKEN@@', token)
    .replace('@@LOGIN_MESSAGE@@', message));
}

async function login(request, response) {
  const csrfCookie = readCookie(request, loginCsrfCookieName);
  const csrfBody = typeof request.body?.csrf_token === 'string' ? request.body.csrf_token : '';
  clearCookie(response, loginCsrfCookieName, '/admin/login');

  if (!/^[a-f0-9]{64}$/.test(csrfCookie) || !constantTimeEqual(csrfCookie, csrfBody)) {
    return renderLogin(response, 403, 'Actualiza esta página e inténtalo de nuevo.');
  }
  if (!rateLimitKey) {
    return renderLogin(response, 503, 'El acceso administrativo requiere configurar ADMIN_RATE_LIMIT_KEY.');
  }
  if (!adminEmail) {
    return renderLogin(response, 503, 'El acceso administrativo requiere configurar ADMIN_EMAIL.');
  }

  const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
  const password = typeof request.body?.password === 'string' ? request.body.password : '';
  if (email.length > 254 || password.length > 1024 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return renderLogin(response, 401, 'Correo o contraseña incorrectos.');
  }

  try {
    const emailKeys = getEmailCryptoKeys();
    const emailHash = lookupAdminEmail(email, emailKeys.lookupKey);
    const configuredAdminHash = lookupAdminEmail(adminEmail, emailKeys.lookupKey);
    const bucketHash = getRateBucket(request);
    if (!bucketHash || !(await allowLoginAttempt(bucketHash))) {
      return renderLogin(response, 429, 'Se alcanzó el límite de intentos. Espera 15 minutos antes de volver a intentarlo.');
    }

    const { rows } = await query(`
      SELECT u.id, u.name, u.email_ciphertext, u.email_nonce, u.email_auth_tag,
             u.email_lookup_hmac, u.password_hash, r.code AS role
      FROM users u
      JOIN roles r ON r.id = u.role_id
      WHERE u.email_lookup_hmac = $1
        AND $1 = $2
        AND u.is_active = TRUE
        AND r.code = 'owner'
      LIMIT 1
    `, [emailHash, configuredAdminHash]);
    const user = rows[0];
    const userEmail = user ? decryptAdminEmail(user, emailKeys) : null;
    const validPassword = user && userEmail === email
      ? await verifyPassword(password, user.password_hash)
      : await scrypt(password, Buffer.alloc(16, 29), 64, passwordParameters).then(() => false);

    if (!user || !validPassword) {
      await query(`
        INSERT INTO audit_log (action, entity_type, result, details)
        VALUES ('admin.login.failed', 'authentication', 'failure', '{"reason":"invalid_credentials"}'::jsonb)
      `);
      return renderLogin(response, 401, 'Correo o contraseña incorrectos.');
    }

    const sessionToken = randomBytes(32).toString('hex');
    const csrfToken = randomBytes(32).toString('hex');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM admin_sessions WHERE expires_at <= now()');
      await client.query('DELETE FROM admin_login_attempts WHERE bucket_hash = $1', [bucketHash]);
      await client.query(`
        INSERT INTO admin_sessions (session_token_hash, user_id, csrf_token, expires_at)
        VALUES ($1, $2, $3, now() + interval '8 hours')
      `, [sha256(sessionToken), user.id, csrfToken]);
      await client.query(`
        INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, result)
        VALUES ($1, 'admin.login.succeeded', 'authentication', $2, 'success')
      `, [user.id, String(user.id)]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }

    response.append('Set-Cookie', `${sessionCookieName}=${sessionToken}; ${cookieOptions(sessionDurationSeconds)}`);
    clearCookie(response, loginCsrfCookieName, '/admin/login');
    response.set('Cache-Control', 'no-store');
    response.redirect(303, '/admin');
  } catch {
    renderLogin(response, 503, 'No fue posible iniciar sesión en este momento.');
  }
}

async function loadAdminSession(request) {
  if (!adminEmail) return null;
  const emailKeys = getEmailCryptoKeys();
  const configuredAdminHash = lookupAdminEmail(adminEmail, emailKeys.lookupKey);
  const token = readCookie(request, sessionCookieName);
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const { rows } = await query(`
    SELECT s.session_token_hash, s.csrf_token, u.id, u.name,
           u.email_ciphertext, u.email_nonce, u.email_auth_tag, u.email_lookup_hmac,
           r.code AS role
    FROM admin_sessions s
    JOIN users u ON u.id = s.user_id
    JOIN roles r ON r.id = u.role_id
    WHERE s.session_token_hash = $1
      AND s.expires_at > now()
      AND u.is_active = TRUE
      AND u.email_lookup_hmac = $2
      AND r.code = 'owner'
    LIMIT 1
  `, [sha256(token), configuredAdminHash]);
  if (!rows.length) return null;
  rows[0].email = decryptAdminEmail(rows[0], emailKeys);
  request.adminSessionToken = token;
  request.adminSession = rows[0];
  return rows[0];
}

export async function requireAdminApi(request, response, next) {
  try {
    if (!(await loadAdminSession(request))) {
      clearCookie(response, sessionCookieName);
      return response.status(401).json({ error: 'Inicia sesión para continuar.' });
    }
    response.set('Cache-Control', 'no-store');
    next();
  } catch {
    response.status(503).json({ error: 'No fue posible validar la sesión.' });
  }
}

export function requireAdminCsrf(request, response, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next();
  const supplied = request.get('X-CSRF-Token');
  if (!constantTimeEqual(supplied, request.adminSession?.csrf_token)) {
    return response.status(403).json({ error: 'La sesión del formulario venció. Recarga la página e inténtalo de nuevo.' });
  }
  next();
}

export function auditAdminAction(client, actorId, action, entityType, entityId, details = {}) {
  return client.query(`
    INSERT INTO audit_log (actor_user_id, action, entity_type, entity_id, result, details)
    VALUES ($1, $2, $3, $4, 'success', $5::jsonb)
  `, [actorId, action, entityType, String(entityId), JSON.stringify(details)]);
}

export async function withAdminTransaction(response, operation) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof AdminInputError) {
      response.status(error.status).json({ error: error.message });
    } else if (error.code === '23505') {
      response.status(409).json({ error: 'Ya existe un registro con ese nombre o identificador.' });
    } else if (error.code === '23503' || error.code === '23514') {
      response.status(400).json({ error: 'Revisa las relaciones y los datos indicados.' });
    } else {
      response.status(503).json({ error: 'No fue posible guardar los cambios.' });
    }
    return null;
  } finally {
    client.release();
  }
}

export function createAdminPageRouter() {
  const pageRouter = express.Router();
  pageRouter.get('/login', async (_request, response) => renderLogin(response, 200, ''));
  pageRouter.post('/login', login);
  pageRouter.get('/recover-password', async (_request, response) => {
    const template = await readFile(recoveryPagePath, 'utf8');
    response.set('Cache-Control', 'no-store').type('html').send(template);
  });
  pageRouter.use(async (request, response, next) => {
    try {
      if (!(await loadAdminSession(request))) {
        clearCookie(response, sessionCookieName);
        return response.redirect(303, '/admin/login');
      }
      response.set('Cache-Control', 'no-store');
      next();
    } catch {
      response.status(503).send('No fue posible validar la sesión.');
    }
  });
  pageRouter.get(['/', '/index.html'], async (request, response) => {
    const template = await readFile(adminPagePath, 'utf8');
    response.set('Cache-Control', 'no-store').type('html').send(
      template.replaceAll('@@ADMIN_CSRF_TOKEN@@', request.adminSession.csrf_token),
    );
  });
  pageRouter.post('/logout', (request, response) => {
    if (!constantTimeEqual(request.get('X-CSRF-Token'), request.adminSession.csrf_token)) {
      return response.status(403).send('La sesión del formulario venció. Recarga la página e inténtalo de nuevo.');
    }
    pool.query('DELETE FROM admin_sessions WHERE session_token_hash = $1', [sha256(request.adminSessionToken)])
      .then(() => {
        clearCookie(response, sessionCookieName);
        response.redirect(303, '/admin/login');
      })
      .catch(() => response.status(503).send('No fue posible cerrar la sesión.'));
  });
  return pageRouter;
}

export function createAdminApiRouter() {
  const apiRouter = express.Router();
  apiRouter.post('/password-recovery/request', adminPasswordRecoveryHandlers.requestCode);
  apiRouter.post('/password-recovery/verify', adminPasswordRecoveryHandlers.verifyCode);
  apiRouter.post('/password-recovery/complete', adminPasswordRecoveryHandlers.completeReset);
  apiRouter.get('/status', async (request, response) => {
    response.set('Cache-Control', 'no-store');
    try {
      const session = await loadAdminSession(request);
      if (!session) {
        clearCookie(response, sessionCookieName);
        return response.json({ authenticated: false });
      }
      response.json({ authenticated: true, role: 'owner' });
    } catch {
      response.status(503).json({ authenticated: false });
    }
  });
  apiRouter.use(requireAdminApi, requireAdminCsrf);
  apiRouter.get('/session', (request, response) => {
    const { id, name, email, role } = request.adminSession;
    response.json({ user: { id, name, email, role }, csrfToken: request.adminSession.csrf_token });
  });
  apiRouter.post('/sessions/revoke', async (request, response) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await auditAdminAction(client, request.adminSession.id, 'admin.sessions.revoked', 'authentication', request.adminSession.id);
      await client.query('DELETE FROM admin_sessions');
      await client.query('COMMIT');
      clearCookie(response, sessionCookieName);
      response.json({ message: 'Se revocaron todas las sesiones. Inicia sesión de nuevo para continuar.' });
    } catch {
      await client.query('ROLLBACK').catch(() => {});
      response.status(503).json({ error: 'No fue posible revocar las sesiones.' });
    } finally {
      client.release();
    }
  });
  return apiRouter;
}
