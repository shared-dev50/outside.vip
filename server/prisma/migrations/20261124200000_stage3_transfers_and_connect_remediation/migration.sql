-- AlterTable
ALTER TABLE "User" ADD COLUMN     "stripeAccountCapabilities" JSONB,
ADD COLUMN     "stripeAccountChargesEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeAccountCreationKey" TEXT,
ADD COLUMN     "stripeAccountCreationLockedBy" TEXT,
ADD COLUMN     "stripeAccountCreationLockedUntil" TIMESTAMP(3),
ADD COLUMN     "stripeAccountDefaultCurrency" TEXT,
ADD COLUMN     "stripeAccountDetailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeAccountDisabledReason" TEXT,
ADD COLUMN     "stripeAccountEventCreatedAt" INTEGER,
ADD COLUMN     "stripeAccountPayoutsEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeAccountRequirements" JSONB,
ADD COLUMN     "stripeAccountSyncedAt" TIMESTAMP(3),
ADD COLUMN     "stripeAccountTransfersCapability" TEXT;

-- AlterTable
ALTER TABLE "OrganizerTransfer" ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "reconciliationLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationLastErrorCode" TEXT,
ADD COLUMN     "reconciliationLastErrorMessage" TEXT,
ADD COLUMN     "reconciliationLockedBy" TEXT,
ADD COLUMN     "reconciliationLockedUntil" TIMESTAMP(3),
ADD COLUMN     "reconciliationNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "reconciliationRequired" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reversedAmountInCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "succeededAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "OrganizerTransfer_status_reconciliationNextAttemptAt_idx" ON "OrganizerTransfer"("status", "reconciliationNextAttemptAt");

-- CreateIndex
CREATE INDEX "OrganizerTransfer_status_reconciliationLockedUntil_idx" ON "OrganizerTransfer"("status", "reconciliationLockedUntil");
