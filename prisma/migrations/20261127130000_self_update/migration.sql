-- Self-update (Settings → Updates)
ALTER TABLE "Settings" ADD COLUMN "selfUpdateAuto" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "selfUpdateHour" INTEGER NOT NULL DEFAULT -1;
