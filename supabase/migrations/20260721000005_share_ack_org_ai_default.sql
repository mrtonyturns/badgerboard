-- Share dialog redesign + Settings redesign backend. Idempotent.

-- Share links: record the responsibility acknowledgment with the link
-- (who acknowledged, when, and the duration they chose).
alter table dossier_shares add column if not exists ack_at timestamptz;
alter table dossier_shares add column if not exists ack_by uuid;
alter table dossier_shares add column if not exists ack_duration_hours integer;

-- Org-level AI-access default (Settings → Data & privacy) rides the existing
-- per-user notification_preferences row; the per-candidate lock always wins.
alter table notification_preferences add column if not exists ai_access_default boolean not null default true;

-- candidates.ai_access_notes becomes tri-state: true = explicitly allowed,
-- false = explicitly locked, null = inherit the owner's org-level default.
alter table candidates alter column ai_access_notes drop not null;
alter table candidates alter column ai_access_notes drop default;
