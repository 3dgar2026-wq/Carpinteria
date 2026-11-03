export class MediaStorageConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaStorageConfigurationError';
  }
}

export function validateMediaStorageConfiguration(env = process.env) {
  const configured = env.MEDIA_STORAGE_PROVIDER;
  const provider = configured === undefined || configured === ''
    ? 'local'
    : (typeof configured === 'string' ? configured.trim().toLowerCase() : '');

  if (env.NODE_ENV === 'production' && configured !== 'cloudinary') {
    throw new MediaStorageConfigurationError(
      'En producción es obligatorio definir exactamente MEDIA_STORAGE_PROVIDER=cloudinary.',
    );
  }
  if (!['local', 'cloudinary'].includes(provider)) {
    throw new MediaStorageConfigurationError('MEDIA_STORAGE_PROVIDER debe ser local o cloudinary.');
  }

  if (provider === 'cloudinary') {
    const required = ['CLOUDINARY_CLOUD_NAME', 'CLOUDINARY_API_KEY', 'CLOUDINARY_API_SECRET'];
    const missing = required.filter((name) => {
      const value = env[name];
      return typeof value !== 'string' || value.length === 0 || value.trim() !== value
        || /[\s\u0000-\u001f\u007f]/.test(value);
    });
    const cloudName = env.CLOUDINARY_CLOUD_NAME;
    if (typeof cloudName === 'string' && !/^[a-z\d_-]{1,255}$/i.test(cloudName)
      && !missing.includes('CLOUDINARY_CLOUD_NAME')) {
      missing.push('CLOUDINARY_CLOUD_NAME');
    }
    if (missing.length) {
      throw new MediaStorageConfigurationError(
        `Configuración de Cloudinary incompleta o inválida: ${missing.join(', ')}. No se muestran valores.`,
      );
    }
  }

  if (env.NODE_ENV === 'production' && provider === 'local') {
    throw new MediaStorageConfigurationError('El almacenamiento local está deshabilitado en producción.');
  }
  return provider;
}
