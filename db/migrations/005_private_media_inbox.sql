ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS original_filename TEXT,
  ADD COLUMN IF NOT EXISTS classification_status TEXT,
  ADD COLUMN IF NOT EXISTS upload_batch_id UUID,
  ADD COLUMN IF NOT EXISTS byte_size BIGINT,
  ADD COLUMN IF NOT EXISTS is_public BOOLEAN;

ALTER TABLE media_assets
  ALTER COLUMN classification_status SET DEFAULT 'pending',
  ALTER COLUMN is_public SET DEFAULT FALSE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_assets_classification_status_check'
      AND conrelid = 'media_assets'::regclass
  ) THEN
    ALTER TABLE media_assets
      ADD CONSTRAINT media_assets_classification_status_check
      CHECK (classification_status IS NULL OR classification_status IN ('pending', 'assigned'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'media_assets_byte_size_check'
      AND conrelid = 'media_assets'::regclass
  ) THEN
    ALTER TABLE media_assets
      ADD CONSTRAINT media_assets_byte_size_check
      CHECK (byte_size IS NULL OR byte_size > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS media_assets_pending_created_idx
  ON media_assets(created_at DESC, id DESC)
  WHERE classification_status = 'pending';
