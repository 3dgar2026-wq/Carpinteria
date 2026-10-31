import nodemailer from 'nodemailer';

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function getPasswordRecoverySmtpOptions(env = process.env) {
  const host = (env.SMTP_HOST ?? '').trim().toLowerCase();
  const port = Number(env.SMTP_PORT);
  const user = (env.SMTP_USER ?? '').trim();
  const appPassword = (env.SMTP_APP_PASSWORD ?? '').replace(/\s/g, '');
  const from = (env.EMAIL_FROM ?? '').trim();
  if (host !== 'smtp.gmail.com' || ![465, 587].includes(port)
    || !emailPattern.test(user) || !/^[A-Za-z0-9]{16}$/.test(appPassword)
    || !emailPattern.test(from) || from.toLowerCase() !== user.toLowerCase()) {
    throw new Error('La configuración SMTP de recuperación no está completa.');
  }
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    tls: { minVersion: 'TLSv1.2' },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 10_000,
    auth: { user, pass: appPassword },
    from,
  };
}

export function createPasswordRecoveryMailer({
  transportFactory = nodemailer.createTransport,
  env = process.env,
} = {}) {
  return async (recipient, code) => {
    if (!emailPattern.test(recipient) || !/^\d{6}$/.test(code)) {
      throw new Error('El mensaje de recuperación no tiene datos válidos.');
    }
    const options = getPasswordRecoverySmtpOptions(env);
    const transporter = transportFactory({
      host: options.host,
      port: options.port,
      secure: options.secure,
      requireTLS: options.requireTLS,
      tls: options.tls,
      connectionTimeout: options.connectionTimeout,
      greetingTimeout: options.greetingTimeout,
      socketTimeout: options.socketTimeout,
      auth: options.auth,
    });
    try {
      await transporter.sendMail({
        from: options.from,
        to: recipient,
        subject: 'Código para recuperar la contraseña de Carpintería',
        text: `Recibimos una solicitud para recuperar la contraseña del panel administrativo.\n\nTu código es: ${code}\n\nVence en 10 minutos. Si no solicitaste este cambio, ignora este mensaje.`,
      });
    } finally {
      await transporter.close?.();
    }
  };
}

export const sendPasswordRecoveryEmail = createPasswordRecoveryMailer();
