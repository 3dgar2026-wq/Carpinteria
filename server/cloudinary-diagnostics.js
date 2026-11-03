const cloudinaryVariableNames = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
];

export function checkCloudinaryEnvironment(env = process.env) {
  const cloudName = env.CLOUDINARY_CLOUD_NAME;
  const apiKey = env.CLOUDINARY_API_KEY;
  const apiSecret = env.CLOUDINARY_API_SECRET;
  return {
    CLOUDINARY_CLOUD_NAME: {
      present: typeof cloudName === 'string' && cloudName.length > 0,
      formatValid: typeof cloudName === 'string' && /^[A-Za-z][A-Za-z0-9-]{1,127}$/.test(cloudName),
    },
    CLOUDINARY_API_KEY: {
      present: typeof apiKey === 'string' && apiKey.length > 0,
      formatValid: typeof apiKey === 'string' && /^[\x21-\x7e]{1,256}$/.test(apiKey),
    },
    CLOUDINARY_API_SECRET: {
      present: typeof apiSecret === 'string' && apiSecret.length > 0,
      formatValid: typeof apiSecret === 'string' && /^[\x21-\x7e]{1,512}$/.test(apiSecret),
    },
  };
}

export function cloudinarySdkConfigMatches(config, env = process.env) {
  return config?.cloud_name === env.CLOUDINARY_CLOUD_NAME
    && config?.api_key === env.CLOUDINARY_API_KEY
    && config?.api_secret === env.CLOUDINARY_API_SECRET
    && config?.secure === true;
}

function safeHttpStatus(error) {
  const candidates = [error?.error?.http_code, error?.http_code, error?.statusCode, error?.status];
  return candidates.find((value) => Number.isInteger(value) && value >= 100 && value <= 599) ?? null;
}

function safeErrorCode(error, httpStatus) {
  const candidates = [error?.error?.code, error?.code];
  const code = candidates.find((value) => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value));
  if (code) return code;
  return httpStatus === null ? null : `HTTP_${httpStatus}`;
}

export function safeCloudinaryError(error, env = process.env) {
  const httpStatus = safeHttpStatus(error);
  const source = error?.error && typeof error.error === 'object' ? error.error : error;
  let message = typeof source?.message === 'string'
    ? source.message
    : typeof error?.message === 'string' ? error.message : '';

  for (const name of cloudinaryVariableNames) {
    const value = env[name];
    if (typeof value === 'string' && value.length >= 3) message = message.split(value).join('[redactado]');
  }
  if (typeof env.CLOUDINARY_URL === 'string' && env.CLOUDINARY_URL.length >= 3) {
    message = message.split(env.CLOUDINARY_URL).join('[redactado]');
  }

  message = message
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[URL omitida]')
    .replace(/authorization\s*[:=]\s*[^\s,;]+/gi, 'Authorization: [omitido]')
    .replace(/((?:api[_ -]?(?:key|secret)|cloud[_ -]?name|password)\s*[:=]\s*)[^\s,;]+/gi, '$1[omitido]')
    .replace(/\b(?:basic|bearer)\s+[A-Za-z0-9+/=_-]+/gi, '[credencial omitida]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);

  return {
    httpStatus,
    code: safeErrorCode(error, httpStatus),
    message: message || (httpStatus ? `Cloudinary respondió HTTP ${httpStatus}.` : 'Cloudinary no devolvió un mensaje seguro.'),
  };
}
