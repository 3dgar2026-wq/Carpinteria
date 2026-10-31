import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('static guard: HTTP parsers reject compressed bodies and enforce request-size limits', async () => {
  const app = await read('server/app.js');
  const adminApi = await read('server/admin-api.js');

  assert.match(app, /express\.json\(\{\s*limit:\s*'32kb',\s*inflate:\s*false\s*\}\)/);
  assert.match(app, /express\.urlencoded\(\{\s*extended:\s*false,\s*limit:\s*'8kb',\s*inflate:\s*false\s*\}\)/);
  assert.match(app, /error\.type === 'entity\.parse\.failed'\)\s*\{\s*return response\.status\(400\)\.json\(\{ error: 'El cuerpo de la solicitud no contiene datos válidos\.' \}\);/);
  assert.match(app, /error\.type === 'entity\.too\.large'\)\s*\{\s*return response\.status\(413\)\.json\(\{ error: 'La solicitud supera el tamaño permitido\.' \}\);/);
  assert.match(app, /error\.type === 'encoding\.unsupported'[\s\S]*?status\(415\)\.json\(\{ error: 'La codificación del cuerpo no está admitida\.' \}\)/);
  assert.equal((adminApi.match(/inflate:\s*false/g) ?? []).length, 2);
});

test('static guard: integration runner restricts connection targets and child environment', async () => {
  const runner = await read('scripts/run-security-integration.js');

  assert.match(runner, /allowedChildEnvironment\s*=\s*\[\s*\.\.\.required/);
  assert.match(runner, /env:\s*childEnvironment/);
  assert.doesNotMatch(runner, /env:\s*process\.env/);
  assert.match(runner, /process\.execPath/);
  assert.match(runner, /127\\\.0\\\.0\\\.1:55432\\\/carpinteria_db/);
  assert.match(runner, /const expectedRuntimeRole = 'carpinteria_runtime'/);
  assert.match(runner, /const expectedSetupRole = 'carpinteria_migrator'/);
  assert.match(runner, /\['postgres:', 'postgresql:'\]\.includes\(url\.protocol\)/);
  assert.match(runner, /runtime\.username !== expectedRuntimeRole \|\| setup\.username !== expectedSetupRole/);
  assert.match(runner, /url\.search !== ''/);
  assert.match(runner, /url\.hash !== ''/);
  assert.match(runner, /else if \(child\.signal\)\s*\{\s*console\.error\([\s\S]*?process\.exitCode = 1;\s*\}/);
  assert.match(runner, /else if \(typeof child\.status === 'number'\)\s*\{\s*process\.exitCode = child\.status;\s*\}/);
});

test('static guard: login SQL binds the submitted email and configured identity as values', async () => {
  const auth = await read('server/admin-auth.js');
  const loginSql = auth.match(/WHERE u\.email_lookup_hmac = \$1[\s\S]*?LIMIT 1\s*`\s*,\s*\[emailHash, configuredAdminHash\]/);

  assert.ok(loginSql, 'login query must bind email and configured admin identity as parameters');
  assert.doesNotMatch(loginSql[0], /\$\{(?:email|adminEmail|request\.)/);
  assert.match(auth, /verifyPassword\(password, user\.password_hash\)/);
  assert.match(auth, /Correo o contraseña incorrectos\./);
});

test('static guard: public estimate and administration search bind external values', async () => {
  const app = await read('server/app.js');
  const adminApi = await read('server/admin-api.js');

  assert.match(app, /WHERE p\.id = \$1 AND p\.is_published = TRUE\s*`\s*,\s*\[id\]/);
  assert.match(app, /const mediaSelection = canVerifyMedia \? `/);
  assert.match(app, /const videoSelection = canVerifyMedia \? `\s*\(/);
  assert.match(adminApi, /AND \(\$1 = '' OR ma\.original_filename ILIKE \$2\)[\s\S]*?\[search, pattern\]/);
  assert.match(adminApi, /LIMIT \$3 OFFSET \$4[\s\S]*?\[search, pattern, limit, offset\]/);
  assert.match(adminApi, /const mediaVisibility = await hasVerifiablePublicMediaColumns\(\)\s*\? '\(ma\.is_public IS TRUE\)'\s*:\s*'FALSE'/);
});

test('static guard: admin API installs session authorization and CSRF middleware before protected routes', async () => {
  const auth = await read('server/admin-auth.js');
  const middleware = auth.indexOf('apiRouter.use(requireAdminApi, requireAdminCsrf)');
  const protectedRoute = auth.indexOf("apiRouter.get('/session'");

  assert.ok(middleware >= 0 && protectedRoute > middleware);
  assert.match(auth, /if \(!constantTimeEqual\(supplied, request\.adminSession\?\.csrf_token\)\)/);
});

test('static guard: estimate endpoint validates the request shape before reading persisted pricing rules', async () => {
  const app = await read('server/app.js');

  assert.match(app, /!body\.measurements \|\| typeof body\.measurements !== 'object' \|\| Array\.isArray\(body\.measurements\)/);
  assert.match(app, /calculateConfiguredEstimate\(\{[\s\S]*?measurements: body\.measurements/);
  assert.match(app, /WHERE p\.id = \$1 AND p\.is_published = TRUE/);
});

test('static guard: public catalog and existing administrative resource routes remain present', async () => {
  const app = await read('server/app.js');
  const adminApi = await read('server/admin-api.js');

  assert.match(app, /app\.get\('\/api\/catalog'/);
  assert.match(app, /app\.post\('\/api\/catalog\/:[^']+\/estimate'/);
  for (const route of ["router.get('/categories'", "router.post('/categories'", "router.get('/products'", "router.post('/products'", "router.patch('/products/:id'", "router.delete('/products/:id'"]) {
    assert.ok(adminApi.includes(route), `expected existing route ${route}`);
  }
});

test('static guard: login limiter retains the five-attempt, fifteen-minute policy without trusting forwarded headers', async () => {
  const auth = await read('server/admin-auth.js');
  const app = await read('server/app.js');

  assert.match(auth, /const loginWindowMs = 15 \* 60 \* 1000/);
  assert.match(auth, /const loginAttemptLimit = 5/);
  assert.match(auth, /request\.socket\.remoteAddress/);
  assert.doesNotMatch(app, /trust proxy/);
});
