const screen = document.querySelector('#startup-screen');
const detail = document.querySelector('#startup-detail');
const spinner = document.querySelector('#startup-spinner');
const retryButton = document.querySelector('#startup-retry');

const maximumWaitMs = 90_000;
const requestTimeoutMs = 8_000;
const retryDelayMs = [1_000, 2_000, 4_000, 5_000];
let attemptNumber = 0;
let checking = false;
let catalogStarted = false;

function wait(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

function showWaitingMessage(elapsedMs) {
  if (elapsedMs >= 30_000) {
    detail.textContent = 'La conexión está tardando un poco más. Seguimos comprobando.';
  }
}

function showRetryMessage(message) {
  detail.textContent = message;
  spinner.hidden = true;
  retryButton.hidden = false;
  screen.setAttribute('aria-busy', 'false');
}

async function startCatalog() {
  if (catalogStarted) return true;
  try {
    await import('/catalog.js');
    catalogStarted = true;
    screen.hidden = true;
    screen.setAttribute('aria-busy', 'false');
    return true;
  } catch {
    showRetryMessage('El sitio está disponible, pero no terminó de cargar. Puedes volver a intentarlo.');
    return false;
  }
}

async function checkAvailability() {
  if (checking || catalogStarted) return;
  checking = true;
  retryButton.hidden = true;
  spinner.hidden = false;
  screen.setAttribute('aria-busy', 'true');
  const startedAt = Date.now();
  attemptNumber = 0;
  detail.textContent = 'Comprobando que el sitio esté disponible.';

  while (Date.now() - startedAt < maximumWaitMs) {
    const elapsedMs = Date.now() - startedAt;
    showWaitingMessage(elapsedMs);
    const controller = new AbortController();
    const remainingMs = maximumWaitMs - elapsedMs;
    const timeoutId = window.setTimeout(() => controller.abort(), Math.min(requestTimeoutMs, remainingMs));

    try {
      const response = await fetch('/api/health', {
        cache: 'no-store',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (response.ok) {
        const health = await response.json();
        if (health?.status === 'ok') {
          checking = false;
          await startCatalog();
          return;
        }
      }
    } catch {
      // A slow or interrupted request is inconclusive; retry within the bounded window.
    } finally {
      window.clearTimeout(timeoutId);
    }

    const delayRemainingMs = maximumWaitMs - (Date.now() - startedAt);
    if (delayRemainingMs <= 0) break;
    const delay = retryDelayMs[Math.min(attemptNumber, retryDelayMs.length - 1)];
    attemptNumber += 1;
    await wait(Math.min(delay, delayRemainingMs));
  }

  checking = false;
  showRetryMessage('El servicio está tardando más de lo esperado. Puedes volver a comprobarlo.');
}

retryButton.addEventListener('click', checkAvailability);
checkAvailability();
