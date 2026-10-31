ALTER TABLE categories
  ADD COLUMN pricing_rules JSONB,
  ADD CONSTRAINT categories_pricing_rules_object_check
    CHECK (pricing_rules IS NULL OR jsonb_typeof(pricing_rules) = 'object');

ALTER TABLE products
  ADD COLUMN measurement_config JSONB,
  ADD COLUMN pricing_rules JSONB,
  ADD CONSTRAINT products_measurement_config_object_check
    CHECK (measurement_config IS NULL OR jsonb_typeof(measurement_config) = 'object'),
  ADD CONSTRAINT products_pricing_rules_object_check
    CHECK (pricing_rules IS NULL OR jsonb_typeof(pricing_rules) = 'object');
