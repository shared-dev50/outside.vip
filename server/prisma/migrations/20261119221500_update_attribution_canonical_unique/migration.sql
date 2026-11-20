-- Drop old unique index and old non-unique index
DROP INDEX IF EXISTS "PromotionVisitorAttribution_visitorIdHash_eventId_key";
DROP INDEX IF EXISTS "PromotionVisitorAttribution_canonicalVisitorId_eventId_idx";

-- Create new unique index on (canonicalVisitorId, eventId)
CREATE UNIQUE INDEX "PromotionVisitorAttribution_canonicalVisitorId_eventId_key" ON "PromotionVisitorAttribution"("canonicalVisitorId", "eventId");

-- Create non-unique index on (visitorIdHash, eventId) for fast versioned hash lookups
CREATE INDEX "PromotionVisitorAttribution_visitorIdHash_eventId_idx" ON "PromotionVisitorAttribution"("visitorIdHash", "eventId");

