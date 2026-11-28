-- Update check for every deployed app, whether or not auto-update is on
ALTER TABLE "Application" ADD COLUMN "updateInfo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Application" ADD COLUMN "updateError" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Application" ADD COLUMN "updateCheckedAt" DATETIME;
