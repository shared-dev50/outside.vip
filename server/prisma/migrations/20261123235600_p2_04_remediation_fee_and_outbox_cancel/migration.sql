-- AlterEnum
ALTER TYPE "EmailOutboxStatus" ADD VALUE IF NOT EXISTS 'CANCELLED';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "stripeActualFeeCurrency" TEXT,
ADD COLUMN     "stripeActualFeeInCents" INTEGER,
ADD COLUMN     "stripeActualFeeRecordedAt" TIMESTAMP(3);
