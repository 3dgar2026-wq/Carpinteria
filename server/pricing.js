const standardFields = new Set(['width_m', 'height_m', 'depth_m', 'length_m', 'thickness_m']);
const allowedOperations = new Set(['add', 'subtract', 'multiply', 'divide']);
const maximumDepth = 12;
const maximumNodes = 64;
const maximumMeasurementCount = 12;

function isMeasurementKey(value) {
  return standardFields.has(value) || (typeof value === 'string' && /^custom_[a-f0-9]{32}$/.test(value));
}

export class InvalidPricingRuleError extends Error {}

export class InvalidMeasurementError extends Error {}

function getDimensionSpecs(config) {
  if (!config) return [];
  if (config.version !== 1 || !Array.isArray(config.dimensions)
    || config.dimensions.length < 1 || config.dimensions.length > maximumMeasurementCount) {
    throw new InvalidMeasurementError('Invalid measurement configuration');
  }

  const seen = new Set();
  return config.dimensions.map((dimension) => {
    if (!dimension || !isMeasurementKey(dimension.key) || seen.has(dimension.key)
      || typeof dimension.label !== 'string' || dimension.label.trim() === '') {
      throw new InvalidMeasurementError('Invalid dimension');
    }

    const min = dimension.min_m === undefined ? 0 : dimension.min_m;
    const max = dimension.max_m;
    const hasMaximum = max !== undefined && max !== null;
    if (typeof min !== 'number' || !Number.isFinite(min) || min < 0
      || (hasMaximum && (typeof max !== 'number' || !Number.isFinite(max) || max < 0 || min > max))) {
      throw new InvalidMeasurementError('Invalid dimension range');
    }

    seen.add(dimension.key);
    return { key: dimension.key, min, max: hasMaximum ? max : null, required: dimension.required !== false };
  });
}

function validateMeasurements(config, rawMeasurements) {
  if (!rawMeasurements || typeof rawMeasurements !== 'object' || Array.isArray(rawMeasurements)) {
    throw new InvalidMeasurementError('Invalid measurements');
  }

  const specs = getDimensionSpecs(config);
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  const measurements = Object.create(null);

  for (const key of Object.keys(rawMeasurements)) {
    if (!byKey.has(key)) throw new InvalidMeasurementError('Unexpected measurement');
  }

  for (const spec of specs) {
    const value = rawMeasurements[spec.key];
    if (value === undefined && !spec.required) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0
      || value < spec.min || (spec.max !== null && value > spec.max)) {
      throw new InvalidMeasurementError('Measurement outside configured range');
    }
    measurements[spec.key] = value;
  }

  if (specs.length === 0 && Object.keys(rawMeasurements).length > 0) {
    throw new InvalidMeasurementError('Measurements are not configured');
  }
  return measurements;
}

function evaluateNode(node, measurements, state, depth) {
  state.nodes += 1;
  if (state.nodes > maximumNodes || depth > maximumDepth) throw new Error('Rule exceeds safe limits');
  if (!node || typeof node !== 'object' || Array.isArray(node)) throw new Error('Invalid rule node');

  if (Object.hasOwn(node, 'field')) {
    if (Object.keys(node).length !== 1 || !isMeasurementKey(node.field)) throw new Error('Invalid rule field');
    const value = measurements[node.field];
    if (!Number.isFinite(value) || value < 0) throw new Error('Missing measurement');
    return value;
  }

  if (Object.hasOwn(node, 'constant')) {
    if (Object.keys(node).length !== 1 || typeof node.constant !== 'number' || !Number.isFinite(node.constant)) {
      throw new Error('Invalid rule constant');
    }
    return node.constant;
  }

  if (!allowedOperations.has(node.op) || !Array.isArray(node.args)) throw new Error('Unsupported rule operation');
  const exactArguments = node.op === 'subtract' || node.op === 'divide';
  const maxArgs = exactArguments ? 2 : 8;
  if (node.args.length < 2 || node.args.length > maxArgs || Object.keys(node).length !== 2) {
    throw new Error('Invalid rule arguments');
  }

  const values = node.args.map((child) => evaluateNode(child, measurements, state, depth + 1));
  if (node.op === 'add') return values.reduce((total, value) => total + value, 0);
  if (node.op === 'multiply') return values.reduce((total, value) => total * value, 1);
  if (node.op === 'subtract') return values[0] - values[1];
  if (values[1] === 0) throw new Error('Division by zero');
  return values[0] / values[1];
}

function estimate(pricingRule, measurements) {
  if (!pricingRule) return { status: 'pending' };
  if (pricingRule.version !== 1 || typeof pricingRule.currency !== 'string'
    || !/^[A-Z]{3}$/.test(pricingRule.currency)) return { status: 'pending' };

  try {
    const amount = evaluateNode(pricingRule.expression, measurements, { nodes: 0 }, 0);
    if (!Number.isFinite(amount) || amount < 0) return { status: 'pending' };
    return { status: 'estimated', amount, currency: pricingRule.currency };
  } catch {
    return { status: 'pending' };
  }
}

export function validatePricingRule(pricingRule) {
  if (pricingRule === null) return;
  if (!pricingRule || typeof pricingRule !== 'object' || Array.isArray(pricingRule)
    || pricingRule.version !== 1 || typeof pricingRule.currency !== 'string'
    || !/^[A-Z]{3}$/.test(pricingRule.currency)
    || !Object.hasOwn(pricingRule, 'expression')
    || Object.keys(pricingRule).some((key) => !['version', 'currency', 'expression'].includes(key))) {
    throw new InvalidPricingRuleError('Invalid pricing rule');
  }

  function validateNode(node, state, depth) {
    state.nodes += 1;
    if (state.nodes > maximumNodes || depth > maximumDepth
      || !node || typeof node !== 'object' || Array.isArray(node)) {
      throw new InvalidPricingRuleError('Invalid pricing expression');
    }

    if (Object.hasOwn(node, 'field')) {
      if (Object.keys(node).length !== 1 || !isMeasurementKey(node.field)) {
        throw new InvalidPricingRuleError('Invalid pricing field');
      }
      return;
    }

    if (Object.hasOwn(node, 'constant')) {
      if (Object.keys(node).length !== 1 || typeof node.constant !== 'number'
        || !Number.isFinite(node.constant)) {
        throw new InvalidPricingRuleError('Invalid pricing constant');
      }
      return;
    }

    const exactArguments = node.op === 'subtract' || node.op === 'divide';
    const maxArgs = exactArguments ? 2 : 8;
    if (!allowedOperations.has(node.op) || !Array.isArray(node.args)
      || node.args.length < 2 || node.args.length > maxArgs || Object.keys(node).length !== 2) {
      throw new InvalidPricingRuleError('Invalid pricing operation');
    }
    node.args.forEach((child) => validateNode(child, state, depth + 1));
  }

  validateNode(pricingRule.expression, { nodes: 0 }, 0);
}

export function calculateConfiguredEstimate({ measurementConfig, pricingRule, measurements }) {
  const validatedMeasurements = validateMeasurements(measurementConfig, measurements);
  return estimate(pricingRule, validatedMeasurements);
}
