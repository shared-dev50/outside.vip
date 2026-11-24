-- Stage 3 Review Remediation: persist external attempt timestamps for Connect creation recovery and Transfer idempotency clocks

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "stripeAccountCreationStartedAt" TIMESTAMP(3);

ALTER TABLE "OrganizerTransfer"
  ADD COLUMN IF NOT EXISTS "lastCreateAttemptAt" TIMESTAMP(3);
