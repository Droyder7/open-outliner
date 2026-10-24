BEGIN;
CREATE TABLE document_update_receipts (
  document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  batch_id UUID NOT NULL,
  digest TEXT NOT NULL,
  revision BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(document_id,batch_id)
);
COMMIT;
