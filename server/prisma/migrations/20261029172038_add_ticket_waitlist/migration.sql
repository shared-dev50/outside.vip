-- CreateEnum
CREATE TYPE "WaitlistEntryStatus" AS ENUM ('WAITING', 'OFFERED', 'PURCHASED', 'EXPIRED', 'DECLINED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "WaitlistOfferStatus" AS ENUM ('PENDING', 'ACCEPTED', 'EXPIRED', 'DECLINED', 'CANCELLED');

-- AlterTable
ALTER TABLE "TicketTier" ADD COLUMN     "waitlistEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "TicketWaitlistEntry" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTierId" TEXT NOT NULL,
    "customerName" TEXT NOT NULL,
    "customerEmail" TEXT NOT NULL,
    "customerPhone" TEXT,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "status" "WaitlistEntryStatus" NOT NULL DEFAULT 'WAITING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketWaitlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TicketWaitlistOffer" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "ticketTierId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "status" "WaitlistOfferStatus" NOT NULL DEFAULT 'PENDING',
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "claimedAt" TIMESTAMP(3),
    "orderId" TEXT,
    "notificationSentAt" TIMESTAMP(3),
    "notificationAttempts" INTEGER NOT NULL DEFAULT 0,
    "notificationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketWaitlistOffer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TicketWaitlistEntry_ticketTierId_status_createdAt_idx" ON "TicketWaitlistEntry"("ticketTierId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "TicketWaitlistEntry_eventId_status_idx" ON "TicketWaitlistEntry"("eventId", "status");

-- CreateIndex
CREATE INDEX "TicketWaitlistEntry_customerEmail_idx" ON "TicketWaitlistEntry"("customerEmail");

-- CreateIndex
CREATE UNIQUE INDEX "TicketWaitlistOffer_tokenHash_key" ON "TicketWaitlistOffer"("tokenHash");

-- CreateIndex
CREATE INDEX "TicketWaitlistOffer_ticketTierId_status_expiresAt_idx" ON "TicketWaitlistOffer"("ticketTierId", "status", "expiresAt");

-- CreateIndex
CREATE INDEX "TicketWaitlistOffer_tokenHash_idx" ON "TicketWaitlistOffer"("tokenHash");

-- CreateIndex
CREATE INDEX "TicketWaitlistOffer_expiresAt_status_idx" ON "TicketWaitlistOffer"("expiresAt", "status");

-- CreateIndex
CREATE INDEX "TicketWaitlistOffer_entryId_idx" ON "TicketWaitlistOffer"("entryId");

-- AddForeignKey
ALTER TABLE "TicketWaitlistEntry" ADD CONSTRAINT "TicketWaitlistEntry_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWaitlistEntry" ADD CONSTRAINT "TicketWaitlistEntry_ticketTierId_fkey" FOREIGN KEY ("ticketTierId") REFERENCES "TicketTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWaitlistOffer" ADD CONSTRAINT "TicketWaitlistOffer_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "TicketWaitlistEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWaitlistOffer" ADD CONSTRAINT "TicketWaitlistOffer_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWaitlistOffer" ADD CONSTRAINT "TicketWaitlistOffer_ticketTierId_fkey" FOREIGN KEY ("ticketTierId") REFERENCES "TicketTier"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TicketWaitlistOffer" ADD CONSTRAINT "TicketWaitlistOffer_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;
