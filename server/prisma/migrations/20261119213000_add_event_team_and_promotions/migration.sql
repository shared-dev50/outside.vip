-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "EventTeamRole" AS ENUM ('ADMIN', 'HOST');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "TeamMemberStatus" AS ENUM ('ACTIVE', 'INACTIVE', 'REVOKED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "TeamInvitationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "PromotionLinkType" AS ENUM ('CAMPAIGN', 'HOST');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateEnum
DO $$
BEGIN
    CREATE TYPE "PromotionLinkStatus" AS ENUM ('ACTIVE', 'DISABLED', 'ARCHIVED');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- CreateTable
CREATE TABLE "EventTeamMember" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "EventTeamRole" NOT NULL,
    "status" "TeamMemberStatus" NOT NULL DEFAULT 'ACTIVE',
    "permissions" JSONB,
    "invitedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTeamMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventTeamInvitation" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "EventTeamRole" NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "status" "TeamInvitationStatus" NOT NULL DEFAULT 'PENDING',
    "permissions" JSONB,
    "invitedByUserId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "acceptedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventTeamInvitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionLink" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "type" "PromotionLinkType" NOT NULL,
    "status" "PromotionLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "name" TEXT NOT NULL,
    "hostMemberId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionSlugRegistry" (
    "slug" TEXT NOT NULL,
    "promotionLinkId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionSlugRegistry_pkey" PRIMARY KEY ("slug")
);

-- CreateTable
CREATE TABLE "PromotionVisitorAttribution" (
    "id" TEXT NOT NULL,
    "visitorIdHash" TEXT NOT NULL,
    "canonicalVisitorId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "promotionLinkId" TEXT NOT NULL,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionVisitorAttribution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionVisitorDay" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "promotionLinkId" TEXT NOT NULL,
    "canonicalVisitorId" TEXT NOT NULL,
    "visitDate" DATE NOT NULL,
    "clickCount" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionVisitorDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionClick" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "promotionLinkId" TEXT NOT NULL,
    "visitorIdHash" TEXT,
    "canonicalVisitorId" TEXT,
    "clickedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "referrer" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "utmTerm" TEXT,
    "utmContent" TEXT,
    "fbclid" TEXT,
    "gclid" TEXT,
    "ttclid" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "PromotionClick_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionDailyAggregate" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "promotionLinkId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "uniqueVisitors" INTEGER NOT NULL DEFAULT 0,
    "totalClicks" INTEGER NOT NULL DEFAULT 0,
    "anonymousClicks" INTEGER NOT NULL DEFAULT 0,
    "completedOrders" INTEGER NOT NULL DEFAULT 0,
    "ticketsSold" INTEGER NOT NULL DEFAULT 0,
    "buyerPaidCents" BIGINT NOT NULL DEFAULT 0,
    "organizerNetCents" BIGINT NOT NULL DEFAULT 0,
    "refundedOrders" INTEGER NOT NULL DEFAULT 0,
    "refundedTickets" INTEGER NOT NULL DEFAULT 0,
    "refundedBuyerCents" BIGINT NOT NULL DEFAULT 0,
    "refundedOrganizerCents" BIGINT NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PromotionDailyAggregate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventTeamMember_eventId_userId_key" ON "EventTeamMember"("eventId", "userId");
CREATE UNIQUE INDEX "EventTeamMember_id_eventId_key" ON "EventTeamMember"("id", "eventId");
CREATE INDEX "EventTeamMember_eventId_role_status_idx" ON "EventTeamMember"("eventId", "role", "status");

-- CreateIndex
CREATE UNIQUE INDEX "EventTeamInvitation_tokenHash_key" ON "EventTeamInvitation"("tokenHash");
CREATE INDEX "EventTeamInvitation_eventId_status_idx" ON "EventTeamInvitation"("eventId", "status");
CREATE INDEX "EventTeamInvitation_email_status_idx" ON "EventTeamInvitation"("email", "status");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionLink_id_eventId_key" ON "PromotionLink"("id", "eventId");
CREATE INDEX "PromotionLink_eventId_status_idx" ON "PromotionLink"("eventId", "status");
CREATE INDEX "PromotionLink_hostMemberId_idx" ON "PromotionLink"("hostMemberId");

-- CreateIndex
CREATE INDEX "PromotionSlugRegistry_promotionLinkId_idx" ON "PromotionSlugRegistry"("promotionLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionVisitorAttribution_visitorIdHash_eventId_key" ON "PromotionVisitorAttribution"("visitorIdHash", "eventId");
CREATE INDEX "PromotionVisitorAttribution_canonicalVisitorId_eventId_idx" ON "PromotionVisitorAttribution"("canonicalVisitorId", "eventId");
CREATE INDEX "PromotionVisitorAttribution_promotionLinkId_eventId_idx" ON "PromotionVisitorAttribution"("promotionLinkId", "eventId");
CREATE INDEX "PromotionVisitorAttribution_expiresAt_idx" ON "PromotionVisitorAttribution"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionVisitorDay_promotionLinkId_canonicalVisitorId_visitDate_key" ON "PromotionVisitorDay"("promotionLinkId", "canonicalVisitorId", "visitDate");
CREATE INDEX "PromotionVisitorDay_eventId_visitDate_idx" ON "PromotionVisitorDay"("eventId", "visitDate");
CREATE INDEX "PromotionVisitorDay_promotionLinkId_visitDate_idx" ON "PromotionVisitorDay"("promotionLinkId", "visitDate");
CREATE INDEX "PromotionVisitorDay_canonicalVisitorId_idx" ON "PromotionVisitorDay"("canonicalVisitorId");

-- CreateIndex
CREATE INDEX "PromotionClick_promotionLinkId_clickedAt_idx" ON "PromotionClick"("promotionLinkId", "clickedAt");
CREATE INDEX "PromotionClick_eventId_clickedAt_idx" ON "PromotionClick"("eventId", "clickedAt");
CREATE INDEX "PromotionClick_clickedAt_idx" ON "PromotionClick"("clickedAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionDailyAggregate_promotionLinkId_date_key" ON "PromotionDailyAggregate"("promotionLinkId", "date");
CREATE INDEX "PromotionDailyAggregate_eventId_date_idx" ON "PromotionDailyAggregate"("eventId", "date");

-- AddForeignKey
ALTER TABLE "EventTeamMember" ADD CONSTRAINT "EventTeamMember_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventTeamMember" ADD CONSTRAINT "EventTeamMember_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventTeamMember" ADD CONSTRAINT "EventTeamMember_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventTeamInvitation" ADD CONSTRAINT "EventTeamInvitation_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EventTeamInvitation" ADD CONSTRAINT "EventTeamInvitation_invitedByUserId_fkey" FOREIGN KEY ("invitedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionLink" ADD CONSTRAINT "PromotionLink_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionLink" ADD CONSTRAINT "PromotionLink_hostMemberId_eventId_fkey" FOREIGN KEY ("hostMemberId", "eventId") REFERENCES "EventTeamMember"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionLink" ADD CONSTRAINT "PromotionLink_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionSlugRegistry" ADD CONSTRAINT "PromotionSlugRegistry_promotionLinkId_fkey" FOREIGN KEY ("promotionLinkId") REFERENCES "PromotionLink"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVisitorAttribution" ADD CONSTRAINT "PromotionVisitorAttribution_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionVisitorAttribution" ADD CONSTRAINT "PromotionVisitorAttribution_promotionLinkId_eventId_fkey" FOREIGN KEY ("promotionLinkId", "eventId") REFERENCES "PromotionLink"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionVisitorDay" ADD CONSTRAINT "PromotionVisitorDay_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionVisitorDay" ADD CONSTRAINT "PromotionVisitorDay_promotionLinkId_eventId_fkey" FOREIGN KEY ("promotionLinkId", "eventId") REFERENCES "PromotionLink"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionClick" ADD CONSTRAINT "PromotionClick_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionClick" ADD CONSTRAINT "PromotionClick_promotionLinkId_eventId_fkey" FOREIGN KEY ("promotionLinkId", "eventId") REFERENCES "PromotionLink"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionDailyAggregate" ADD CONSTRAINT "PromotionDailyAggregate_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromotionDailyAggregate" ADD CONSTRAINT "PromotionDailyAggregate_promotionLinkId_eventId_fkey" FOREIGN KEY ("promotionLinkId", "eventId") REFERENCES "PromotionLink"("id", "eventId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================================================
-- CUSTOM ARCHITECTURAL INVARIANTS (PARTIAL INDEXES, CHECKS, TRIGGERS)
-- =========================================================================

-- 1. Partial Unique Index: Exactly at most one primary slug per promotion link
CREATE UNIQUE INDEX "idx_unique_primary_slug_per_link" 
ON "PromotionSlugRegistry" ("promotionLinkId") 
WHERE ("isPrimary" = true);

-- 2. Partial Unique Index: At most one personal HOST link per event per host
CREATE UNIQUE INDEX "idx_unique_host_link_per_event" 
ON "PromotionLink" ("eventId", "hostMemberId") 
WHERE ("type" = 'HOST' AND "hostMemberId" IS NOT NULL);

-- 3. Partial Unique Index: At most one PENDING invitation per event and normalized email
CREATE UNIQUE INDEX "idx_unique_pending_team_invitation" 
ON "EventTeamInvitation" ("eventId", "email") 
WHERE ("status" = 'PENDING');

-- 4. CHECK Constraint: PromotionLink type and hostMemberId nullability
ALTER TABLE "PromotionLink" ADD CONSTRAINT "chk_promotion_link_type_host"
CHECK (
  ("type" = 'HOST' AND "hostMemberId" IS NOT NULL) OR
  ("type" = 'CAMPAIGN' AND "hostMemberId" IS NULL)
);

-- 5. CHECK Constraint: Normalized email on EventTeamInvitation
ALTER TABLE "EventTeamInvitation" ADD CONSTRAINT "chk_team_invitation_email_normalized"
CHECK (
  "email" = LOWER(TRIM("email")) AND
  "email" NOT LIKE '% %' AND
  POSITION('@' IN "email") > 1
);

-- 6. Deferred Constraint Trigger: Ensure exactly one primary slug for an ACTIVE PromotionLink
CREATE OR REPLACE FUNCTION trg_fn_enforce_primary_slug_exists()
RETURNS TRIGGER AS $$
DECLARE
  v_link_id TEXT;
  v_count INT;
  v_status "PromotionLinkStatus";
BEGIN
  v_link_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."promotionLinkId" ELSE NEW."promotionLinkId" END;
  
  SELECT status INTO v_status FROM "PromotionLink" WHERE id = v_link_id;
  
  IF FOUND AND v_status = 'ACTIVE' THEN
    SELECT COUNT(*) INTO v_count 
    FROM "PromotionSlugRegistry" 
    WHERE "promotionLinkId" = v_link_id AND "isPrimary" = true;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Active PromotionLink % must have exactly one primary slug in PromotionSlugRegistry, found %', v_link_id, v_count;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_ensure_primary_slug_per_active_link
AFTER INSERT OR UPDATE OR DELETE ON "PromotionSlugRegistry"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_enforce_primary_slug_exists();

-- 7. Deferred Constraint Trigger: Ensure PromotionLink status change to ACTIVE has primary slug
CREATE OR REPLACE FUNCTION trg_fn_enforce_link_status_slug()
RETURNS TRIGGER AS $$
DECLARE
  v_count INT;
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    SELECT COUNT(*) INTO v_count 
    FROM "PromotionSlugRegistry" 
    WHERE "promotionLinkId" = NEW.id AND "isPrimary" = true;

    IF v_count <> 1 THEN
      RAISE EXCEPTION 'Active PromotionLink % must have exactly one primary slug in PromotionSlugRegistry, found %', NEW.id, v_count;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER trg_ensure_link_has_primary_slug_on_status_change
AFTER INSERT OR UPDATE OF status ON "PromotionLink"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION trg_fn_enforce_link_status_slug();

-- 8. Validation Trigger: Ensure PromotionLink hostMemberId references role = 'HOST'
CREATE OR REPLACE FUNCTION trg_fn_validate_promotion_link_host()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW."hostMemberId" IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM "EventTeamMember"
      WHERE id = NEW."hostMemberId"
        AND "eventId" = NEW."eventId"
        AND "role" = 'HOST'
    ) THEN
      RAISE EXCEPTION 'PromotionLink hostMemberId must reference an EventTeamMember with role HOST for the same event';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_validate_promotion_link_host
BEFORE INSERT OR UPDATE ON "PromotionLink"
FOR EACH ROW EXECUTE FUNCTION trg_fn_validate_promotion_link_host();

-- 9. Protection Trigger: Prevent EventTeamMember role change away from HOST if any PromotionLink references it
CREATE OR REPLACE FUNCTION trg_fn_protect_host_role_mutation()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role = 'HOST' AND NEW.role <> 'HOST' THEN
    IF EXISTS (
      SELECT 1 FROM "PromotionLink" 
      WHERE "hostMemberId" = OLD.id
    ) THEN
      RAISE EXCEPTION 'Cannot change EventTeamMember % role from HOST to % while dependent PromotionLinks exist. Historical host relationships are immutable.', OLD.id, NEW.role;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_protect_host_role_mutation
BEFORE UPDATE OF role ON "EventTeamMember"
FOR EACH ROW EXECUTE FUNCTION trg_fn_protect_host_role_mutation();

