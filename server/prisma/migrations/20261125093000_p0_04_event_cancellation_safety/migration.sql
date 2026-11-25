-- Stage 4 P0-04: Event Cancellation Financial and Admission Safety

ALTER TYPE "CheckInResult" ADD VALUE IF NOT EXISTS 'EVENT_CANCELLED';
ALTER TYPE "EmailOutboxType" ADD VALUE IF NOT EXISTS 'EVENT_CANCELLED_BUYER';
ALTER TYPE "EmailOutboxType" ADD VALUE IF NOT EXISTS 'EVENT_CANCELLED_ORGANIZER';

ALTER TABLE "Event"
  ADD COLUMN IF NOT EXISTS "cancelledAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "cancelledByUserId" TEXT,
  ADD COLUMN IF NOT EXISTS "cancellationReason" TEXT;

CREATE INDEX IF NOT EXISTS "Event_organizerId_status_idx" ON "Event"("organizerId", "status");
