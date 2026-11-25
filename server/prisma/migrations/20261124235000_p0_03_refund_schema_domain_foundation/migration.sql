-- Stage 4 P0-03 Workstream B: Refund Schema and Domain Foundation
-- NOTE: Prepared migration SQL only; NOT applied to any database in this workstream.
-- NOTE FOR FUTURE MIGRATIONS: Prisma 5 DSL cannot express PostgreSQL CHECK constraints
-- or the partial unique index OrderRefundTicket_active_or_confirmed_ticket_key. When creating
-- subsequent migrations with `npx prisma migrate dev --create-only`, verify that these
-- PostgreSQL-native constraints and partial indexes are preserved intact.

-- AlterEnum
ALTER TYPE "TicketStatus" ADD VALUE IF NOT EXISTS 'REFUND_PENDING';

-- AlterEnum
ALTER TYPE "CheckInResult" ADD VALUE IF NOT EXISTS 'REFUND_PENDING_TICKET';
ALTER TYPE "CheckInResult" ADD VALUE IF NOT EXISTS 'REFUNDED_TICKET';

-- AlterEnum
ALTER TYPE "EmailOutboxType" ADD VALUE IF NOT EXISTS 'BUYER_REFUND_CONFIRMED';
ALTER TYPE "EmailOutboxType" ADD VALUE IF NOT EXISTS 'BUYER_REFUND_MANUAL_REVIEW';

-- AlterEnum
ALTER TYPE "OrderRefundStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- CreateEnum
CREATE TYPE "OrderRefundKind" AS ENUM (
  'LATE_PAYMENT',
  'ORGANIZER_TICKET_REFUND',
  'ADMIN_TICKET_REFUND',
  'EVENT_CANCELLATION',
  'EXTERNAL_STRIPE_RECONCILED'
);

-- CreateEnum
CREATE TYPE "RefundInitiatorRole" AS ENUM (
  'SYSTEM',
  'ORGANIZER',
  'ADMIN',
  'STRIPE_WEBHOOK'
);

-- CreateEnum
CREATE TYPE "RefundFeeBearer" AS ENUM (
  'NOT_APPLICABLE',
  'ORGANIZER',
  'PLATFORM',
  'SHARED'
);

-- CreateEnum
CREATE TYPE "OrderRefundTicketLockState" AS ENUM (
  'ACTIVE_PENDING',
  'CONFIRMED',
  'RELEASED'
);

-- DropIndex (Allow multiple partial refunds against the same Stripe PaymentIntent)
DROP INDEX IF EXISTS "OrderRefund_stripePaymentIntentId_key";

-- AlterTable "Order"
ALTER TABLE "Order"
  ADD COLUMN "refundedAmountInCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pendingRefundAmountInCents" INTEGER NOT NULL DEFAULT 0;

-- Order refund cumulative cap constraints
ALTER TABLE "Order"
  ADD CONSTRAINT "Order_refundedAmountInCents_nonnegative_chk" CHECK ("refundedAmountInCents" >= 0),
  ADD CONSTRAINT "Order_pendingRefundAmountInCents_nonnegative_chk" CHECK ("pendingRefundAmountInCents" >= 0),
  ADD CONSTRAINT "Order_cumulativeRefundCap_chk" CHECK ("refundedAmountInCents" + "pendingRefundAmountInCents" <= "totalInCents");

-- AlterTable "Ticket"
ALTER TABLE "Ticket"
  ADD COLUMN "allocatedGrossInCents" INTEGER,
  ADD COLUMN "allocatedPlatformFeeInCents" INTEGER,
  ADD COLUMN "allocatedServiceFeeInCents" INTEGER,
  ADD COLUMN "allocatedProcessingFeeInCents" INTEGER,
  ADD COLUMN "allocatedBuyerTotalInCents" INTEGER,
  ADD COLUMN "refundedAt" TIMESTAMP(3),
  ADD COLUMN "refundedByUserId" TEXT,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancelledByUserId" TEXT,
  ADD COLUMN "cancellationReason" TEXT;

-- Ticket persisted allocation consistency & non-negativity constraint
ALTER TABLE "Ticket"
  ADD CONSTRAINT "Ticket_persistedAllocation_chk" CHECK (
    (
      "allocatedGrossInCents" IS NULL
      AND "allocatedPlatformFeeInCents" IS NULL
      AND "allocatedServiceFeeInCents" IS NULL
      AND "allocatedProcessingFeeInCents" IS NULL
      AND "allocatedBuyerTotalInCents" IS NULL
    )
    OR (
      "allocatedGrossInCents" >= 0
      AND "allocatedPlatformFeeInCents" >= 0
      AND "allocatedServiceFeeInCents" >= 0
      AND "allocatedProcessingFeeInCents" >= 0
      AND "allocatedBuyerTotalInCents" >= 0
      AND "allocatedBuyerTotalInCents" = (
        "allocatedGrossInCents"
        + "allocatedPlatformFeeInCents"
        + "allocatedServiceFeeInCents"
        + "allocatedProcessingFeeInCents"
      )
    )
  );

-- CreateIndex for composite FK integrity
CREATE UNIQUE INDEX "Ticket_id_orderId_key" ON "Ticket"("id", "orderId");

-- AlterTable "OrderRefund"
ALTER TABLE "OrderRefund"
  ADD COLUMN "refundKind" "OrderRefundKind" NOT NULL DEFAULT 'LATE_PAYMENT',
  ADD COLUMN "initiatorRole" "RefundInitiatorRole" NOT NULL DEFAULT 'SYSTEM',
  ADD COLUMN "initiatedByUserId" TEXT,
  ADD COLUMN "feeBearer" "RefundFeeBearer" NOT NULL DEFAULT 'NOT_APPLICABLE',
  ADD COLUMN "refundStripeProcessingFee" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "ticketSubtotalInCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "platformFeeReversedInCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "serviceFeeReversedInCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "processingFeeInCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "organizerDebitInCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "platformExpenseInCents" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "restoreInventory" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "inventoryRestoredCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cancelledAt" TIMESTAMP(3),
  ADD COLUMN "cancellationReason" TEXT;

ALTER TABLE "OrderRefund"
  ADD CONSTRAINT "OrderRefund_amounts_chk" CHECK (
    "amountInCents" > 0
    AND "ticketSubtotalInCents" >= 0
    AND "platformFeeReversedInCents" >= 0
    AND "serviceFeeReversedInCents" >= 0
    AND "processingFeeInCents" >= 0
    AND "organizerDebitInCents" >= 0
    AND "platformExpenseInCents" >= 0
    AND "inventoryRestoredCount" >= 0
  );

-- CreateIndex on "OrderRefund"
CREATE UNIQUE INDEX "OrderRefund_id_orderId_key" ON "OrderRefund"("id", "orderId");
CREATE INDEX "OrderRefund_stripePaymentIntentId_idx" ON "OrderRefund"("stripePaymentIntentId");
CREATE INDEX "OrderRefund_orderId_refundKind_status_idx" ON "OrderRefund"("orderId", "refundKind", "status");
CREATE INDEX "OrderRefund_initiatedByUserId_idx" ON "OrderRefund"("initiatedByUserId");

-- AddForeignKey for initiatedByUserId
ALTER TABLE "OrderRefund"
  ADD CONSTRAINT "OrderRefund_initiatedByUserId_fkey"
  FOREIGN KEY ("initiatedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable "OrderRefundTicket"
CREATE TABLE "OrderRefundTicket" (
  "id" TEXT NOT NULL,
  "orderRefundId" TEXT NOT NULL,
  "orderId" TEXT NOT NULL,
  "ticketId" TEXT NOT NULL,
  "lockState" "OrderRefundTicketLockState" NOT NULL DEFAULT 'ACTIVE_PENDING',
  "allocatedGrossInCents" INTEGER NOT NULL,
  "allocatedPlatformFeeInCents" INTEGER NOT NULL,
  "allocatedServiceFeeInCents" INTEGER NOT NULL,
  "allocatedProcessingFeeInCents" INTEGER NOT NULL,
  "allocatedBuyerTotalInCents" INTEGER NOT NULL,
  "refundedAmountInCents" INTEGER NOT NULL,
  "restoreInventory" BOOLEAN NOT NULL DEFAULT false,
  "inventoryRestored" BOOLEAN NOT NULL DEFAULT false,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "OrderRefundTicket_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "OrderRefundTicket_amounts_chk" CHECK (
    "allocatedGrossInCents" >= 0
    AND "allocatedPlatformFeeInCents" >= 0
    AND "allocatedServiceFeeInCents" >= 0
    AND "allocatedProcessingFeeInCents" >= 0
    AND "allocatedBuyerTotalInCents" >= 0
    AND "allocatedBuyerTotalInCents" = (
      "allocatedGrossInCents"
      + "allocatedPlatformFeeInCents"
      + "allocatedServiceFeeInCents"
      + "allocatedProcessingFeeInCents"
    )
    AND "refundedAmountInCents" > 0
    AND "refundedAmountInCents" <= "allocatedBuyerTotalInCents"
  )
);

-- CreateIndex on "OrderRefundTicket"
CREATE UNIQUE INDEX "OrderRefundTicket_orderRefundId_ticketId_key" ON "OrderRefundTicket"("orderRefundId", "ticketId");
CREATE INDEX "OrderRefundTicket_orderId_idx" ON "OrderRefundTicket"("orderId");
CREATE INDEX "OrderRefundTicket_ticketId_lockState_idx" ON "OrderRefundTicket"("ticketId", "lockState");

-- Partial unique index: a ticket can have at most ONE active or confirmed refund lock at a time.
-- Cancelled refunds transition lockState -> 'RELEASED', permitting future re-initiation without losing history.
CREATE UNIQUE INDEX "OrderRefundTicket_active_or_confirmed_ticket_key"
  ON "OrderRefundTicket"("ticketId")
  WHERE "lockState" IN ('ACTIVE_PENDING', 'CONFIRMED');

-- ForeignKeys: modeled in schema.prisma using composite (id, orderId) relations with RESTRICT semantics
-- so financial/refund audit records cannot be cascade-deleted and OrderRefund.orderId cannot be nulled
-- while linked OrderRefundTicket rows exist.
ALTER TABLE "OrderRefundTicket"
  ADD CONSTRAINT "OrderRefundTicket_orderId_fkey"
  FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderRefundTicket"
  ADD CONSTRAINT "OrderRefundTicket_orderRefundId_orderId_fkey"
  FOREIGN KEY ("orderRefundId", "orderId") REFERENCES "OrderRefund"("id", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "OrderRefundTicket"
  ADD CONSTRAINT "OrderRefundTicket_ticketId_orderId_fkey"
  FOREIGN KEY ("ticketId", "orderId") REFERENCES "Ticket"("id", "orderId") ON DELETE RESTRICT ON UPDATE RESTRICT;
