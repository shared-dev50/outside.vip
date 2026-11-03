-- AlterTable
ALTER TABLE "Event" ADD COLUMN "placeId" TEXT;

-- CreateIndex
CREATE INDEX "Event_placeId_idx" ON "Event"("placeId");
