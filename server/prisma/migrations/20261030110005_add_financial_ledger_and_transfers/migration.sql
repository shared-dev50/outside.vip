-- CreateEnum
CREATE TYPE "LedgerEntryType" AS ENUM ('TICKET_SALE_PENDING', 'TICKET_SALE_CLEARED', 'TRANSFER_INITIATED', 'TRANSFER_SUCCEEDED', 'TRANSFER_FAILED', 'REFUND_PENDING', 'REFUND_CLEARED', 'REFUND_POST_TRANSFER', 'DISPUTE_HOLD', 'DISPUTE_WON', 'DISPUTE_LOST', 'PLATFORM_FEE', 'SERVICE_FEE', 'STRIPE_PROCESSING_FEE', 'ADJUSTMENT');

-- CreateEnum
CREATE TYPE "LedgerBalanceType" AS ENUM ('PENDING', 'AVAILABLE', 'TRANSFERRED', 'PLATFORM_REVENUE', 'RECOVERABLE');

-- CreateEnum
CREATE TYPE "TransferStatus" AS ENUM ('PENDING', 'SUCCEEDED', 'FAILED', 'REVERSED');

-- CreateEnum
CREATE TYPE "TransferSourceType" AS ENUM ('MANUAL_ORGANIZER_REQUEST', 'ADMIN_INITIATED', 'AUTOMATIC_SCHEDULED');

-- CreateEnum
CREATE TYPE "PayoutStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'CANCELLED');

-- CreateTable
CREATE TABLE "OrganizerBalance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "pendingBalanceInCents" INTEGER NOT NULL DEFAULT 0,
    "availableBalanceInCents" INTEGER NOT NULL DEFAULT 0,
    "transferredBalanceInCents" INTEGER NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FinancialLedgerEntry" (
    "id" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "eventId" TEXT,
    "orderId" TEXT,
    "transferId" TEXT,
    "type" "LedgerEntryType" NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "balanceType" "LedgerBalanceType" NOT NULL,
    "stripeReferenceId" TEXT,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialLedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizerTransfer" (
    "id" TEXT NOT NULL,
    "transferNumber" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "TransferStatus" NOT NULL DEFAULT 'PENDING',
    "stripeTransferId" TEXT,
    "sourceType" "TransferSourceType" NOT NULL DEFAULT 'MANUAL_ORGANIZER_REQUEST',
    "initiatedByUserId" TEXT NOT NULL,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerTransfer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConnectedPayout" (
    "id" TEXT NOT NULL,
    "organizerId" TEXT NOT NULL,
    "stripeAccountId" TEXT NOT NULL,
    "stripePayoutId" TEXT NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "status" "PayoutStatus" NOT NULL DEFAULT 'PENDING',
    "arrivalDate" TIMESTAMP(3),
    "destinationBankMasked" TEXT,
    "failureCode" TEXT,
    "failureMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ConnectedPayout_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerBalance_userId_key" ON "OrganizerBalance"("userId");

-- CreateIndex
CREATE INDEX "OrganizerBalance_userId_idx" ON "OrganizerBalance"("userId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_organizerId_createdAt_idx" ON "FinancialLedgerEntry"("organizerId", "createdAt");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_eventId_idx" ON "FinancialLedgerEntry"("eventId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_orderId_idx" ON "FinancialLedgerEntry"("orderId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_transferId_idx" ON "FinancialLedgerEntry"("transferId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_stripeReferenceId_idx" ON "FinancialLedgerEntry"("stripeReferenceId");

-- CreateIndex
CREATE INDEX "FinancialLedgerEntry_type_idx" ON "FinancialLedgerEntry"("type");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerTransfer_transferNumber_key" ON "OrganizerTransfer"("transferNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerTransfer_stripeTransferId_key" ON "OrganizerTransfer"("stripeTransferId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerTransfer_idempotencyKey_key" ON "OrganizerTransfer"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrganizerTransfer_organizerId_createdAt_idx" ON "OrganizerTransfer"("organizerId", "createdAt");

-- CreateIndex
CREATE INDEX "OrganizerTransfer_status_idx" ON "OrganizerTransfer"("status");

-- CreateIndex
CREATE INDEX "OrganizerTransfer_stripeTransferId_idx" ON "OrganizerTransfer"("stripeTransferId");

-- CreateIndex
CREATE INDEX "OrganizerTransfer_transferNumber_idx" ON "OrganizerTransfer"("transferNumber");

-- CreateIndex
CREATE UNIQUE INDEX "ConnectedPayout_stripePayoutId_key" ON "ConnectedPayout"("stripePayoutId");

-- CreateIndex
CREATE INDEX "ConnectedPayout_organizerId_createdAt_idx" ON "ConnectedPayout"("organizerId", "createdAt");

-- CreateIndex
CREATE INDEX "ConnectedPayout_stripeAccountId_idx" ON "ConnectedPayout"("stripeAccountId");

-- CreateIndex
CREATE INDEX "ConnectedPayout_stripePayoutId_idx" ON "ConnectedPayout"("stripePayoutId");

-- CreateIndex
CREATE INDEX "ConnectedPayout_status_idx" ON "ConnectedPayout"("status");

-- AddForeignKey
ALTER TABLE "OrganizerBalance" ADD CONSTRAINT "OrganizerBalance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FinancialLedgerEntry" ADD CONSTRAINT "FinancialLedgerEntry_transferId_fkey" FOREIGN KEY ("transferId") REFERENCES "OrganizerTransfer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerTransfer" ADD CONSTRAINT "OrganizerTransfer_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerTransfer" ADD CONSTRAINT "OrganizerTransfer_initiatedByUserId_fkey" FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectedPayout" ADD CONSTRAINT "ConnectedPayout_organizerId_fkey" FOREIGN KEY ("organizerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
