-- CreateEnum
CREATE TYPE "StripeSettlementStatus" AS ENUM ('PENDING', 'SETTLED', 'FAILED_PERMANENT');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stripeAvailableOn" TIMESTAMP(3),
ADD COLUMN     "stripeBalanceTransactionId" TEXT,
ADD COLUMN     "stripeSettlementAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stripeSettlementFailedAt" TIMESTAMP(3),
ADD COLUMN     "stripeSettlementLastAttemptAt" TIMESTAMP(3),
ADD COLUMN     "stripeSettlementLastErrorCategory" TEXT,
ADD COLUMN     "stripeSettlementLastErrorCode" TEXT,
ADD COLUMN     "stripeSettlementLastErrorMessage" TEXT,
ADD COLUMN     "stripeSettlementLockedBy" TEXT,
ADD COLUMN     "stripeSettlementLockedUntil" TIMESTAMP(3),
ADD COLUMN     "stripeSettlementNextAttemptAt" TIMESTAMP(3),
ADD COLUMN     "stripeSettlementStatus" "StripeSettlementStatus";

-- CreateIndex
CREATE INDEX "Order_status_paymentProvider_stripeSettlementStatus_stripeS_idx" ON "Order"("status", "paymentProvider", "stripeSettlementStatus", "stripeSettlementNextAttemptAt");

-- CreateIndex
CREATE INDEX "Order_stripeSettlementLockedUntil_idx" ON "Order"("stripeSettlementLockedUntil");
