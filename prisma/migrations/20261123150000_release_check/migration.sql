-- New DeployNow releases (Settings → Updates)
ALTER TABLE "Settings" ADD COLUMN "releaseCheck" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Settings" ADD COLUMN "latestRelease" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Settings" ADD COLUMN "latestReleaseUrl" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Settings" ADD COLUMN "latestReleaseNotes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Settings" ADD COLUMN "releaseCheckedAt" DATETIME;
ALTER TABLE "Settings" ADD COLUMN "releaseNotified" TEXT NOT NULL DEFAULT '';
