-- Enforce Host Membership and Promotional Link Lifecycle Invariant:
-- A Host link may be ACTIVE only when its associated membership has role = HOST and status = ACTIVE.
-- An INACTIVE Host must not have an active promotional link.
-- A REVOKED Host must not have an active promotional link.
-- A member whose role changes away from HOST must not have an active Host link.

-- 1. Validation Trigger Function for PromotionLink (BEFORE INSERT OR UPDATE):
CREATE OR REPLACE FUNCTION trg_fn_validate_promotion_link_host()
RETURNS TRIGGER AS $$
DECLARE
  v_role "EventTeamRole";
  v_status "TeamMemberStatus";
BEGIN
  IF NEW."hostMemberId" IS NOT NULL THEN
    SELECT role, status INTO v_role, v_status
    FROM "EventTeamMember"
    WHERE id = NEW."hostMemberId"
      AND "eventId" = NEW."eventId";

    IF NOT FOUND THEN
      RAISE EXCEPTION 'PromotionLink hostMemberId must reference an EventTeamMember for the same event';
    END IF;

    IF NEW.status = 'ACTIVE' THEN
      IF v_role <> 'HOST' THEN
        RAISE EXCEPTION 'Active PromotionLink hostMemberId must reference an EventTeamMember with role HOST for the same event';
      END IF;
      IF v_status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'Active PromotionLink hostMemberId must reference an EventTeamMember with role HOST and status ACTIVE for the same event';
      END IF;
    ELSIF NEW.status = 'DISABLED' THEN
      IF v_role <> 'HOST' THEN
        RAISE EXCEPTION 'Disabled PromotionLink hostMemberId must reference an EventTeamMember with role HOST for the same event';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_validate_promotion_link_host ON "PromotionLink";
CREATE TRIGGER trg_validate_promotion_link_host
BEFORE INSERT OR UPDATE ON "PromotionLink"
FOR EACH ROW EXECUTE FUNCTION trg_fn_validate_promotion_link_host();

-- 2. Protection Trigger Function for EventTeamMember (BEFORE UPDATE OF role, status):
CREATE OR REPLACE FUNCTION trg_fn_protect_host_membership_mutation()
RETURNS TRIGGER AS $$
BEGIN
  -- If role is changing away from HOST, verify that no active or disabled links exist
  IF OLD.role = 'HOST' AND NEW.role <> 'HOST' THEN
    IF EXISTS (
      SELECT 1 FROM "PromotionLink"
      WHERE "hostMemberId" = OLD.id
        AND "status" <> 'ARCHIVED'
    ) THEN
      RAISE EXCEPTION 'Cannot change EventTeamMember % role from HOST to % while dependent PromotionLinks exist. Dependent links must be ARCHIVED first.', OLD.id, NEW.role;
    END IF;
  END IF;

  -- If status is changing away from ACTIVE for a HOST, verify that no ACTIVE links exist
  IF OLD.role = 'HOST' AND NEW.role = 'HOST' AND NEW.status <> 'ACTIVE' THEN
    IF EXISTS (
      SELECT 1 FROM "PromotionLink"
      WHERE "hostMemberId" = OLD.id
        AND "status" = 'ACTIVE'
    ) THEN
      RAISE EXCEPTION 'Cannot change EventTeamMember % status to % while active PromotionLinks exist. Personal links must be disabled or archived first.', OLD.id, NEW.status;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_host_role_mutation ON "EventTeamMember";
DROP TRIGGER IF EXISTS trg_protect_host_membership_mutation ON "EventTeamMember";
CREATE TRIGGER trg_protect_host_membership_mutation
BEFORE UPDATE OF role, status ON "EventTeamMember"
FOR EACH ROW EXECUTE FUNCTION trg_fn_protect_host_membership_mutation();
