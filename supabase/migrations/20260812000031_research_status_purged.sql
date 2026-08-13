-- recruit-retention-purge.js sets research_status='purged'; the original CHECK
-- did not allow it. Idempotent.
ALTER TABLE recruitment_prospects DROP CONSTRAINT IF EXISTS recruitment_prospects_research_status_check;
ALTER TABLE recruitment_prospects ADD CONSTRAINT recruitment_prospects_research_status_check
  CHECK (research_status IN ('pending','researching','done','error','skipped_quota','purged'));
