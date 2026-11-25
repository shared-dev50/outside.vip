-- M-02 Durable session invalidation on password change / reset

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "passwordChangedAt" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "sessionVersion" INTEGER NOT NULL DEFAULT 0;
