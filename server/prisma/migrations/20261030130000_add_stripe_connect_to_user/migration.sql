-- AlterTable
ALTER TABLE "User" ADD COLUMN "stripeAccountId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "User_stripeAccountId_key" ON "User"("stripeAccountId");
