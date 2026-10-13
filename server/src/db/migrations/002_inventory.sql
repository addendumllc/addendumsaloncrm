-- Inventory order requests: stylists list Addendum Hair products they need; the request is emailed
-- to the ordering contact (default gaby@addendumhair.com) and tracked until received.

CREATE TABLE inventory_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number BIGSERIAL UNIQUE,
  requested_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,   -- who submitted it
  for_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,            -- stylist it's for
  status TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted','ordered','received','cancelled')),
  urgency TEXT NOT NULL DEFAULT 'normal' CHECK (urgency IN ('normal','rush')),
  needed_by DATE,
  note TEXT,
  -- Email delivery (never lost: failed sends are retried automatically)
  email_to TEXT NOT NULL,
  email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending','sent','failed','not_configured')),
  email_attempts INT NOT NULL DEFAULT 0,
  email_last_attempt_at TIMESTAMPTZ,
  email_sent_at TIMESTAMPTZ,
  email_message_id TEXT,
  email_error TEXT,
  email_subject TEXT,
  email_text TEXT,
  status_changed_at TIMESTAMPTZ,
  status_changed_by_staff_id UUID REFERENCES staff(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_requests_created_idx ON inventory_requests(created_at DESC);
CREATE INDEX inventory_requests_status_idx ON inventory_requests(status);
CREATE INDEX inventory_requests_for_staff_idx ON inventory_requests(for_staff_id);
CREATE INDEX inventory_requests_email_retry_idx ON inventory_requests(email_status) WHERE email_status IN ('pending','failed');

CREATE TABLE inventory_request_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id UUID NOT NULL REFERENCES inventory_requests(id) ON DELETE CASCADE,
  position INT NOT NULL DEFAULT 0,
  product TEXT NOT NULL,
  details TEXT,                 -- shade / colour, length, weight, size…
  quantity INT NOT NULL CHECK (quantity > 0 AND quantity <= 999),
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,   -- optional: the client it's for
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX inventory_request_items_request_idx ON inventory_request_items(request_id);
CREATE INDEX inventory_request_items_product_idx ON inventory_request_items(lower(product));
