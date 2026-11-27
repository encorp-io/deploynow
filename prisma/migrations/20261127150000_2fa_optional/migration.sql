-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "githubUser" TEXT NOT NULL DEFAULT '',
    "githubToken" TEXT NOT NULL DEFAULT '',
    "pollingInterval" INTEGER NOT NULL DEFAULT 60,
    "autoUpdateLatest" BOOLEAN NOT NULL DEFAULT false,
    "require2faForAdmins" BOOLEAN NOT NULL DEFAULT false,
    "vaultAddr" TEXT NOT NULL DEFAULT '',
    "vaultNamespace" TEXT NOT NULL DEFAULT '',
    "vaultAuth" TEXT NOT NULL DEFAULT 'token',
    "vaultToken" TEXT NOT NULL DEFAULT '',
    "vaultRoleId" TEXT NOT NULL DEFAULT '',
    "vaultSecretId" TEXT NOT NULL DEFAULT '',
    "vaultCaCert" TEXT NOT NULL DEFAULT '',
    "agentCaCert" TEXT NOT NULL DEFAULT '',
    "agentCaKey" TEXT NOT NULL DEFAULT '',
    "agentServerCert" TEXT NOT NULL DEFAULT '',
    "agentServerKey" TEXT NOT NULL DEFAULT '',
    "agentPublicUrl" TEXT NOT NULL DEFAULT '',
    "platformDomain" TEXT NOT NULL DEFAULT '',
    "alertDiskPercent" INTEGER NOT NULL DEFAULT 90,
    "alertMemPercent" INTEGER NOT NULL DEFAULT 95,
    "alertCrashRestarts" INTEGER NOT NULL DEFAULT 3,
    "releaseCheck" BOOLEAN NOT NULL DEFAULT true,
    "latestRelease" TEXT NOT NULL DEFAULT '',
    "latestReleaseUrl" TEXT NOT NULL DEFAULT '',
    "latestReleaseNotes" TEXT NOT NULL DEFAULT '',
    "releaseCheckedAt" DATETIME,
    "releaseNotified" TEXT NOT NULL DEFAULT '',
    "selfUpdateAuto" BOOLEAN NOT NULL DEFAULT false,
    "selfUpdateHour" INTEGER NOT NULL DEFAULT -1,
    "statusPageEnabled" BOOLEAN NOT NULL DEFAULT false,
    "statusPageTitle" TEXT NOT NULL DEFAULT '',
    "portainerUrl" TEXT NOT NULL DEFAULT '',
    "portainerApiKey" TEXT NOT NULL DEFAULT '',
    "portainerEndpointId" INTEGER NOT NULL DEFAULT 1
);
INSERT INTO "new_Settings" ("agentCaCert", "agentCaKey", "agentPublicUrl", "agentServerCert", "agentServerKey", "alertCrashRestarts", "alertDiskPercent", "alertMemPercent", "autoUpdateLatest", "githubToken", "githubUser", "id", "latestRelease", "latestReleaseNotes", "latestReleaseUrl", "platformDomain", "pollingInterval", "portainerApiKey", "portainerEndpointId", "portainerUrl", "releaseCheck", "releaseCheckedAt", "releaseNotified", "require2faForAdmins", "schemaVersion", "selfUpdateAuto", "selfUpdateHour", "statusPageEnabled", "statusPageTitle", "vaultAddr", "vaultAuth", "vaultCaCert", "vaultNamespace", "vaultRoleId", "vaultSecretId", "vaultToken") SELECT "agentCaCert", "agentCaKey", "agentPublicUrl", "agentServerCert", "agentServerKey", "alertCrashRestarts", "alertDiskPercent", "alertMemPercent", "autoUpdateLatest", "githubToken", "githubUser", "id", "latestRelease", "latestReleaseNotes", "latestReleaseUrl", "platformDomain", "pollingInterval", "portainerApiKey", "portainerEndpointId", "portainerUrl", "releaseCheck", "releaseCheckedAt", "releaseNotified", "require2faForAdmins", "schemaVersion", "selfUpdateAuto", "selfUpdateHour", "statusPageEnabled", "statusPageTitle", "vaultAddr", "vaultAuth", "vaultCaCert", "vaultNamespace", "vaultRoleId", "vaultSecretId", "vaultToken" FROM "Settings";
DROP TABLE "Settings";
ALTER TABLE "new_Settings" RENAME TO "Settings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

