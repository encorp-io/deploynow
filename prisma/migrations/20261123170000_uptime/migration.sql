-- CreateTable
CREATE TABLE "UptimeCheck" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "target" TEXT NOT NULL,
    "applicationId" TEXT,
    "intervalSec" INTEGER NOT NULL DEFAULT 60,
    "timeoutMs" INTEGER NOT NULL DEFAULT 10000,
    "expectStatus" TEXT NOT NULL DEFAULT '',
    "keyword" TEXT NOT NULL DEFAULT '',
    "failThreshold" INTEGER NOT NULL DEFAULT 2,
    "certWarnDays" INTEGER NOT NULL DEFAULT 14,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "public" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "consecutiveFails" INTEGER NOT NULL DEFAULT 0,
    "lastCheckedAt" DATETIME,
    "lastChangeAt" DATETIME,
    "lastLatencyMs" INTEGER,
    "lastError" TEXT NOT NULL DEFAULT '',
    "certExpiresAt" DATETIME,
    "certCheckedAt" DATETIME,
    "certWarned" BOOLEAN NOT NULL DEFAULT false,
    "nextCheckAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UptimeResult" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checkId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ok" BOOLEAN NOT NULL,
    "latencyMs" INTEGER,
    "statusCode" INTEGER,
    "error" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "UptimeResult_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "UptimeCheck" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UptimeDay" (
    "checkId" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "up" INTEGER NOT NULL DEFAULT 0,
    "latencySum" INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY ("checkId", "day"),
    CONSTRAINT "UptimeDay_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "UptimeCheck" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "UptimeIncident" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "checkId" TEXT NOT NULL,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endedAt" DATETIME,
    "error" TEXT NOT NULL DEFAULT '',
    CONSTRAINT "UptimeIncident_checkId_fkey" FOREIGN KEY ("checkId") REFERENCES "UptimeCheck" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- AlterTable
ALTER TABLE "Settings" ADD COLUMN "statusPageEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Settings" ADD COLUMN "statusPageTitle" TEXT NOT NULL DEFAULT '';

-- CreateIndex
CREATE INDEX "UptimeCheck_nextCheckAt_idx" ON "UptimeCheck"("nextCheckAt");

-- CreateIndex
CREATE INDEX "UptimeResult_checkId_at_idx" ON "UptimeResult"("checkId", "at");

-- CreateIndex
CREATE INDEX "UptimeIncident_checkId_startedAt_idx" ON "UptimeIncident"("checkId", "startedAt");

