-- CreateEnum
CREATE TYPE "OrderRefundStatus" AS ENUM ('PENDING', 'PROCESSING', 'STRIPE_PENDING', 'SUCCEEDED', 'MANUAL_REVIEW_REQUIRED', 'MANUALLY_RESOLVED');

-- AlterEnum
ALTER TYPE "EmailOutboxType" ADD VALUE IF NOT EXISTS 'LATE_PAYMENT_REFUND_CONFIRMED';
ALTER TYPE "EmailOutboxType" ADD VALUE IF NOT EXISTS 'LATE_PAYMENT_REFUND_MANUAL_REVIEW';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stripeFundsAvailableAt" TIMESTAMP(3),
ADD COLUMN     "stripeSettledChargeId" TEXT;

-- CreateTable
CREATE TABLE "OrderRefund" (
    "id" TEXT NOT NULL,
    "orderId" TEXT,
    "stripePaymentIntentId" TEXT NOT NULL,
    "stripeChargeId" TEXT,
    "stripeRefundId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "amountInCents" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "reason" TEXT NOT NULL,
    "status" "OrderRefundStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedBy" TEXT,
    "lockedUntil" TIMESTAMP(3),
    "lastErrorCategory" TEXT,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "lastAttemptAt" TIMESTAMP(3),
    "succeededAt" TIMESTAMP(3),
    "failedAt" TIMESTAMP(3),
    "requiresManualResolution" BOOLEAN NOT NULL DEFAULT false,
    "resolvedAt" TIMESTAMP(3),
    "resolvedByUserId" TEXT,
    "resolvedByEmail" TEXT,
    "resolutionAction" TEXT,
    "resolutionNotes" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderRefund_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderRefund_stripePaymentIntentId_key" ON "OrderRefund"("stripePaymentIntentId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRefund_stripeRefundId_key" ON "OrderRefund"("stripeRefundId");

-- CreateIndex
CREATE UNIQUE INDEX "OrderRefund_idempotencyKey_key" ON "OrderRefund"("idempotencyKey");

-- CreateIndex
CREATE INDEX "OrderRefund_status_nextAttemptAt_idx" ON "OrderRefund"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OrderRefund_status_lockedUntil_idx" ON "OrderRefund"("status", "lockedUntil");

-- CreateIndex
CREATE INDEX "OrderRefund_requiresManualResolution_resolvedAt_idx" ON "OrderRefund"("requiresManualResolution", "resolvedAt");

-- CreateIndex
CREATE INDEX "OrderRefund_orderId_idx" ON "OrderRefund"("orderId");

-- CreateIndex
CREATE INDEX "Order_paymentReference_idx" ON "Order"("paymentReference");

-- AddForeignKey
ALTER TABLE "OrderRefund" ADD CONSTRAINT "OrderRefund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
