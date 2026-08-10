-- Team claim verdicts (Profiler reader): after opening a Verify link the user
-- records Valid / False / Unsure per claim; the report stops flagging resolved
-- claims. Keyed by a stable hash of the claim text.
-- { "<claimKey>": { verdict: "valid"|"false"|"unsure", at: iso, by: uuid } }
-- Owner updates are allowed by the existing dossiers_update_own policy.
alter table dossiers add column if not exists claim_verdicts jsonb not null default '{}'::jsonb;
