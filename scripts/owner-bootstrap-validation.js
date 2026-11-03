const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidConfiguredAdminEmail(email) {
  return typeof email === 'string' && emailPattern.test(email) && email.length <= 254;
}

export function validateOwnerBootstrapInput({ name, email, password }) {
  const diagnostics = [];
  const ownerName = typeof name === 'string' ? name : '';
  const adminEmail = typeof email === 'string' ? email : '';
  const ownerPassword = typeof password === 'string' ? password : '';

  if (!ownerName) diagnostics.push('OWNER_NAME_REQUIRED');
  if (ownerName.length > 160) diagnostics.push('OWNER_NAME_TOO_LONG');
  if (!isValidConfiguredAdminEmail(adminEmail)) diagnostics.push('ADMIN_EMAIL_INVALID');
  if (Array.from(ownerPassword).length < 12) diagnostics.push('PASSWORD_TOO_SHORT');
  if (Buffer.byteLength(ownerPassword, 'utf8') > 256) diagnostics.push('PASSWORD_TOO_LONG_BYTES');

  return diagnostics;
}
