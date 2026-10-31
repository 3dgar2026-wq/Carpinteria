import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const required = [
  'CARPINTERIA_SECURITY_TEST_ACK',
  'CARPINTERIA_SECURITY_TEST_DB_MARKER',
  'CARPINTERIA_SECURITY_TEST_RUNTIME_URL',
  'CARPINTERIA_SECURITY_TEST_SETUP_URL',
];
const allowedChildEnvironment = [
  ...required,
  'CARPINTERIA_SECURITY_TEST_REQUIRE_CONFIG',
];
const expectedRuntimeRole = 'carpinteria_runtime';
const expectedSetupRole = 'carpinteria_migrator';
const missing = required.filter((name) => typeof process.env[name] !== 'string'
  || process.env[name].trim().length === 0);

function parseTestConnectionUrl(value) {
  if (typeof value !== 'string'
    || !/^postgres(?:ql)?:\/\/(?:[a-z\d._~-]|%[a-f\d]{2})+:(?:[a-z\d._~-]|%[a-f\d]{2})+@127\.0\.0\.1:55432\/carpinteria_db$/iu.test(value)) return null;

  try {
    const url = new URL(value);
    if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || url.hostname !== '127.0.0.1'
      || url.port !== '55432'
      || url.pathname !== '/carpinteria_db'
      || url.search !== ''
      || url.hash !== '') return null;

    const username = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (!username || !password || /[\u0000-\u001f\u007f]/u.test(username + password)) return null;
    return { username };
  } catch {
    return null;
  }
}

if (missing.length) {
  console.error(`Integración de seguridad OMITIDA: faltan variables requeridas (${missing.join(', ')}). No es una validación aprobada.`);
  process.exitCode = 2;
} else {
  const testConfigurationFailure = (() => {
    if (process.env.CARPINTERIA_SECURITY_TEST_ACK !== 'disposable-loopback-postgres') {
      return 'la confirmación de base desechable no es válida';
    }
    if (!/^carpinteria-security-test:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      process.env.CARPINTERIA_SECURITY_TEST_DB_MARKER,
    )) return 'el marcador de base desechable no es válido';

    const runtime = parseTestConnectionUrl(process.env.CARPINTERIA_SECURITY_TEST_RUNTIME_URL);
    const setup = parseTestConnectionUrl(process.env.CARPINTERIA_SECURITY_TEST_SETUP_URL);
    if (!runtime || !setup) return 'las conexiones deben usar credenciales y el destino PostgreSQL desechable documentado, sin parámetros ni fragmentos';
    if (runtime.username !== expectedRuntimeRole || setup.username !== expectedSetupRole) {
      return 'las conexiones deben usar los roles de prueba runtime y migrator documentados';
    }
    return null;
  })();

  if (testConfigurationFailure) {
    console.error(`Integración de seguridad NO EJECUTADA: ${testConfigurationFailure}. No se creó el proceso de pruebas.`);
    process.exitCode = 2;
  } else if (!path.isAbsolute(process.execPath)) {
    console.error('Integración de seguridad NO EJECUTADA: no se pudo determinar una ruta absoluta para Node.js.');
    process.exitCode = 2;
  } else {
    const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    // Use the absolute Node executable and pass only test-specific values. This is
    // environment minimization; it is not an OS-enforced process sandbox.
    const childEnvironment = Object.fromEntries(allowedChildEnvironment.map((name) => [
      name,
      name === 'CARPINTERIA_SECURITY_TEST_REQUIRE_CONFIG'
        ? '1'
        : process.env[name],
    ]));
    const child = spawnSync(process.execPath, ['--test', 'test/security-integration.test.js'], {
      cwd: projectRoot,
      env: childEnvironment,
      stdio: 'inherit',
    });

    if (child.error) {
      console.error(`No se pudo iniciar el runner de integración (${child.error.name}).`);
      process.exitCode = 1;
    } else if (child.signal) {
      console.error(`Integración de seguridad interrumpida por señal ${child.signal}; no se considera aprobada.`);
      process.exitCode = 1;
    } else if (typeof child.status === 'number') {
      process.exitCode = child.status;
    } else {
      console.error('Integración de seguridad sin código de salida; no se considera aprobada.');
      process.exitCode = 1;
    }
  }
}
