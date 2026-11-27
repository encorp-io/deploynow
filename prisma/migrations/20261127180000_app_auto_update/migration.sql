-- Auto-update for every kind of app (image, compose, Git): schedule, maintenance window, rollback
ALTER TABLE "Application" ADD COLUMN "autoUpdate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Application" ADD COLUMN "autoUpdateEvery" INTEGER NOT NULL DEFAULT 15;
ALTER TABLE "Application" ADD COLUMN "autoUpdateDays" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Application" ADD COLUMN "autoUpdateFrom" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Application" ADD COLUMN "autoUpdateTo" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Application" ADD COLUMN "autoUpdateTimezone" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Application" ADD COLUMN "autoUpdateRollback" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Application" ADD COLUMN "autoUpdateCheckedAt" DATETIME;
ALTER TABLE "Application" ADD COLUMN "autoUpdatePending" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Application" ADD COLUMN "autoUpdateError" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Application" ADD COLUMN "autoUpdateSkip" TEXT NOT NULL DEFAULT '';

-- Image apps with the old "auto-digest" policy keep updating, now through the auto-update settings.
-- They checked on every poll (about a minute), so keep that pace.
UPDATE "Application" SET "autoUpdate" = true, "autoUpdateEvery" = 1, "updatePolicy" = 'manual' WHERE "updatePolicy" = 'auto-digest';

-- Compose deployments remember the digest each service ran, so rolling back restores those images
ALTER TABLE "Deployment" ADD COLUMN "serviceImages" TEXT NOT NULL DEFAULT '';

CREATE TABLE "AutoUpdateRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "summary" TEXT NOT NULL DEFAULT '',
    "changes" TEXT NOT NULL DEFAULT '[]',
    "deploymentId" TEXT NOT NULL DEFAULT '',
    "previousDeploymentId" TEXT NOT NULL DEFAULT '',
    "rollbackDeploymentId" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'deploying',
    "error" TEXT NOT NULL DEFAULT '',
    "verifyAfter" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "AutoUpdateRun_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "AutoUpdateRun_applicationId_createdAt_idx" ON "AutoUpdateRun"("applicationId", "createdAt");
CREATE INDEX "AutoUpdateRun_status_idx" ON "AutoUpdateRun"("status");

-- Channels that get deploy notifications also get the auto-update ones
UPDATE "NotificationChannel" SET "events" = "events" || ',autoupdate.failure' WHERE ',' || "events" || ',' LIKE '%,deploy.failure,%';
UPDATE "NotificationChannel" SET "events" = "events" || ',autoupdate.success' WHERE ',' || "events" || ',' LIKE '%,deploy.success,%';
