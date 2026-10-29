-- CreateEnum
CREATE TYPE "EventFeatureType" AS ENUM ('PERFORMER', 'SPONSOR', 'SPEAKER', 'HOST', 'OTHER');

-- AlterTable
ALTER TABLE "Event" ADD COLUMN     "hideGuestCount" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPasswordProtected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "showOnExplore" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "youtubeVideoId" TEXT,
ADD COLUMN     "youtubeVideoUrl" TEXT;

-- AlterTable
ALTER TABLE "EventSeries" ADD COLUMN     "hideGuestCount" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPasswordProtected" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "passwordHash" TEXT,
ADD COLUMN     "showOnExplore" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "youtubeVideoId" TEXT,
ADD COLUMN     "youtubeVideoUrl" TEXT;

-- CreateTable
CREATE TABLE "EventGalleryImage" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "imageUrl" TEXT NOT NULL,
    "publicId" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventGalleryImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventFeature" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "EventFeatureType" NOT NULL DEFAULT 'PERFORMER',
    "imageUrl" TEXT,
    "imagePublicId" TEXT,
    "description" TEXT,
    "displayOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EventFeature_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EventGalleryImage_eventId_displayOrder_idx" ON "EventGalleryImage"("eventId", "displayOrder");

-- CreateIndex
CREATE INDEX "EventFeature_eventId_displayOrder_idx" ON "EventFeature"("eventId", "displayOrder");

-- CreateIndex
CREATE INDEX "Event_showOnExplore_status_idx" ON "Event"("showOnExplore", "status");

-- AddForeignKey
ALTER TABLE "EventGalleryImage" ADD CONSTRAINT "EventGalleryImage_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventFeature" ADD CONSTRAINT "EventFeature_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "Event"("id") ON DELETE CASCADE ON UPDATE CASCADE;
