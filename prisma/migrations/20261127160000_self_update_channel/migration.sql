-- Self-update channel (Settings → Updates)
ALTER TABLE "Settings" ADD COLUMN "selfUpdateChannel" TEXT NOT NULL DEFAULT '';
