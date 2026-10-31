const maximumFixedDimensionCount = 12;

export function normalizeFixedDimensions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.version !== 1 || !Array.isArray(value.dimensions)
    || value.dimensions.length < 1 || value.dimensions.length > maximumFixedDimensionCount) {
    return null;
  }

  const dimensions = [];
  for (const dimension of value.dimensions) {
    if (!dimension || typeof dimension !== 'object' || Array.isArray(dimension)
      || typeof dimension.label !== 'string' || !dimension.label.trim()
      || dimension.label.trim().length > 60
      || typeof dimension.value_m !== 'number' || !Number.isFinite(dimension.value_m)
      || dimension.value_m < 0) {
      return null;
    }
    dimensions.push({ label: dimension.label.trim(), value_m: dimension.value_m });
  }

  return { version: 1, dimensions };
}
