-- Admin email mute: one list every sender checks before every send.
--
-- Keyed by EMAIL (not user id) on purpose: it survives account deletion, it
-- covers senders that only have an address in hand (Resend calls in
-- monitoring-digest.js, Stripe-driven mail), and an admin can silence an
-- address before the account even exists. _email.js consults it inside
-- sendEmail(); monitoring-digest.js consults it before its direct Resend
-- call. Service-role only — no client policy, nothing to leak.

CREATE TABLE IF NOT EXISTS email_suppressions (
  email       TEXT PRIMARY KEY,
  reason      TEXT,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE email_suppressions ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: only the service role (which bypasses RLS) may
-- read or write. Clients never touch this table.

COMMENT ON TABLE email_suppressions IS
  'Addresses that must receive NO email from Badger Board. Checked by _email.js sendEmail() and monitoring-digest.js. Managed via admin-manage-access mute_emails/unmute_emails.';
