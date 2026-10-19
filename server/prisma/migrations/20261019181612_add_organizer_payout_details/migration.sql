-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "payoutDetailsId" TEXT;

-- CreateTable
CREATE TABLE "OrganizerPayoutDetails" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "orgType" TEXT NOT NULL,
    "orgTypeOther" TEXT,
    "registeredName" TEXT NOT NULL,
    "registrationNumber" TEXT,
    "country" TEXT NOT NULL,
    "address" TEXT,
    "contactPersonName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "accountHolderName" TEXT NOT NULL,
    "bankName" TEXT NOT NULL,
    "bankCountry" TEXT NOT NULL,
    "accountCurrency" TEXT NOT NULL DEFAULT 'USD',
    "accountNumberMasked" TEXT NOT NULL,
    "accountNumberLast4" TEXT NOT NULL,
    "accountNumberEncrypted" TEXT,
    "bankBranch" TEXT,
    "swiftBic" TEXT,
    "routingCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrganizerPayoutDetails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrganizerPayoutDetails_userId_key" ON "OrganizerPayoutDetails"("userId");

-- CreateIndex
CREATE INDEX "OrganizerPayoutDetails_userId_idx" ON "OrganizerPayoutDetails"("userId");

-- AddForeignKey
ALTER TABLE "Event" ADD CONSTRAINT "Event_payoutDetailsId_fkey" FOREIGN KEY ("payoutDetailsId") REFERENCES "OrganizerPayoutDetails"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizerPayoutDetails" ADD CONSTRAINT "OrganizerPayoutDetails_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
