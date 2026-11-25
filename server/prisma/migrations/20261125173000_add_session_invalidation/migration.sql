-- CreateTable
CREATE TABLE "SessionInvalidation" (
    "userId" TEXT NOT NULL,
    "minSessionVersion" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SessionInvalidation_pkey" PRIMARY KEY ("userId")
);

-- AddForeignKey
ALTER TABLE "SessionInvalidation" ADD CONSTRAINT "SessionInvalidation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill any existing users whose sessionVersion was already incremented
INSERT INTO "SessionInvalidation" ("userId", "minSessionVersion", "updatedAt")
SELECT id, "sessionVersion", COALESCE("passwordChangedAt", CURRENT_TIMESTAMP)
FROM "User"
WHERE "sessionVersion" > 0
ON CONFLICT ("userId") DO UPDATE
SET
    "minSessionVersion" = GREATEST("SessionInvalidation"."minSessionVersion", EXCLUDED."minSessionVersion"),
    "updatedAt" = CURRENT_TIMESTAMP;
