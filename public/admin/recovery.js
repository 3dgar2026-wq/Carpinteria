const statusElement = document.querySelector('#recovery-status');
const requestForm = document.querySelector('#recovery-request-form');
const codeForm = document.querySelector('#recovery-code-form');
const passwordForm = document.querySelector('#recovery-password-form');
const emailInput = document.querySelector('#recovery-email');
let recoveryEmail = '';

async function post(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  return { response, result };
}

function showMessage(message) {
  statusElement.textContent = message;
}

requestForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  recoveryEmail = emailInput.value.trim();
  try {
    const { result } = await post('/api/admin/password-recovery/request', { email: recoveryEmail });
    requestForm.hidden = true;
    codeForm.hidden = false;
    showMessage(result.message || 'Si el correo corresponde a una cuenta administrativa, recibirás un código si fue posible completar la solicitud.');
  } catch {
    showMessage('No fue posible procesar la solicitud. Inténtalo de nuevo más tarde.');
  }
});

codeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const code = new FormData(codeForm).get('code');
  try {
    const { response, result } = await post('/api/admin/password-recovery/verify', {
      email: recoveryEmail,
      code,
    });
    if (!response.ok) {
      showMessage(result.error || 'El código no es válido o venció. Solicita uno nuevo e inténtalo otra vez.');
      return;
    }
    codeForm.hidden = true;
    passwordForm.hidden = false;
    showMessage(result.message || 'Código válido. Ya puedes establecer una contraseña nueva.');
  } catch {
    showMessage('No fue posible validar el código. Inténtalo de nuevo.');
  }
});

passwordForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const formData = new FormData(passwordForm);
  const password = formData.get('password');
  const confirmation = formData.get('confirmation');
  try {
    const { response, result } = await post('/api/admin/password-recovery/complete', { password, confirmation });
    if (!response.ok) {
      showMessage(result.error || 'No fue posible actualizar la contraseña.');
      return;
    }
    passwordForm.hidden = true;
    showMessage(result.message || 'La contraseña se actualizó. Inicia sesión con la nueva contraseña.');
  } catch {
    showMessage('No fue posible actualizar la contraseña. Inténtalo de nuevo.');
  }
});
