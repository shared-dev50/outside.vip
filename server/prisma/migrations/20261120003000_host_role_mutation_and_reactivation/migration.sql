-- Reconcile trigger functions for Host role mutation and link lifecycle

-- 1. Validation Trigger Function:
-- An active or disabled host link must reference an EventTeamMember with role HOST for the same event.
-- Archived host links preserve historical attribution and do not block past host records.
CREATE OR REPLACE FUNCTION trg_fn_validate_promotion_link_host()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."hostMemberId" IS NOT NULL AND NEW."status" <> 'ARCHIVED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM "EventTeamMember"
      WHERE id = NEW."hostMemberId"
        AND "eventId" = NEW."eventId"
        AND "role" = 'HOST'
    ) THEN
      RAISE EXCEPTION 'Active PromotionLink hostMemberId must reference an EventTeamMember with role HOST for the same event';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 2. Protection Trigger Function:
-- Changing an EventTeamMember role away from HOST requires all dependent PromotionLinks to be ARCHIVED first.
-- This guarantees active/disabled links are never orphaned or mismatched, while allowing role transitions
-- once historical links are properly archived.
CREATE OR REPLACE FUNCTION trg_fn_protect_host_role_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role = 'HOST' AND NEW.role <> 'HOST' THEN
    IF EXISTS (
      SELECT 1 FROM "PromotionLink" 
      WHERE "hostMemberId" = OLD.id
        AND "status" <> 'ARCHIVED'
    ) THEN
      RAISE EXCEPTION 'Cannot change EventTeamMember % role from HOST to % while dependent PromotionLinks exist. Dependent links must be ARCHIVED first.', OLD.id, NEW.role;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
