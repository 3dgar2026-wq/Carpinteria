ALTER TABLE categories
  ADD COLUMN measurement_template JSONB,
  ADD CONSTRAINT categories_measurement_template_object_check
    CHECK (measurement_template IS NULL OR jsonb_typeof(measurement_template) = 'object');
