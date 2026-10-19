-- AlterTable
ALTER TABLE "Order" ADD COLUMN "platformFeeInCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "organizerNetInCents" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "orderAccessToken" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_orderAccessToken_key" ON "Order"("orderAccessToken");

-- CreateIndex
CREATE INDEX "Order_orderAccessToken_idx" ON "Order"("orderAccessToken");
