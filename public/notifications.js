let notificationRegion;

function getNotificationRegion() {
  if (notificationRegion?.isConnected) return notificationRegion;
  notificationRegion = document.createElement('div');
  notificationRegion.className = 'notification-region';
  notificationRegion.setAttribute('aria-label', 'Notificaciones');
  document.body.append(notificationRegion);
  return notificationRegion;
}

export function showNotification(message, { type = 'success', actionLabel = '', actionHref = '', duration = 5000 } = {}) {
  const notification = document.createElement('div');
  notification.className = `notification notification-${type}`;
  notification.setAttribute('role', type === 'error' ? 'alert' : 'status');
  notification.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');

  const icon = document.createElement('span');
  icon.className = 'notification-icon';
  icon.setAttribute('aria-hidden', 'true');
  icon.textContent = type === 'error' ? '!' : '✓';
  const content = document.createElement('div');
  content.className = 'notification-content';
  const text = document.createElement('p');
  text.className = 'notification-message';
  text.textContent = message;
  content.append(text);
  if (actionLabel && actionHref) {
    const action = document.createElement('a');
    action.className = 'notification-action';
    action.href = actionHref;
    action.textContent = actionLabel;
    content.append(action);
  }

  const close = document.createElement('button');
  close.className = 'notification-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Cerrar notificación');
  close.textContent = '×';
  notification.append(icon, content, close);
  const region = getNotificationRegion();
  region.append(notification);
  let timer;
  const dismiss = () => {
    window.clearTimeout(timer);
    notification.classList.add('notification-leaving');
    notification.addEventListener('animationend', () => notification.remove(), { once: true });
    window.setTimeout(() => notification.remove(), 220);
  };
  close.addEventListener('click', dismiss, { once: true });
  timer = window.setTimeout(dismiss, duration);
  return dismiss;
}
