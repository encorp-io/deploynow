-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'operator',
    "totpSecret" TEXT NOT NULL DEFAULT '',
    "totpPending" TEXT NOT NULL DEFAULT '',
    "totpEnabledAt" DATETIME,
    "totpLastStep" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" DATETIME,
    "lastLoginAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RecoveryCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecoveryCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "stepUpAt" DATETIME,
    CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RoleBinding" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "scopeType" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RoleBinding_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TeamInvite" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'operator',
    "expiresAt" DATETIME NOT NULL,
    "used" BOOLEAN NOT NULL DEFAULT false,
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "TeamInvite_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "User" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "LoginThrottle" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "count" INTEGER NOT NULL DEFAULT 0,
    "firstAttempt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedUntil" DATETIME
);

-- CreateTable
CREATE TABLE "Endpoint" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "port" INTEGER,
    "username" TEXT NOT NULL DEFAULT '',
    "credentials" TEXT NOT NULL DEFAULT '',
    "hostKeyFingerprint" TEXT NOT NULL DEFAULT '',
    "labels" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "dockerVersion" TEXT NOT NULL DEFAULT '',
    "os" TEXT NOT NULL DEFAULT '',
    "cpus" INTEGER NOT NULL DEFAULT 0,
    "memoryBytes" REAL NOT NULL DEFAULT 0,
    "containers" INTEGER NOT NULL DEFAULT 0,
    "lastSeenAt" DATETIME,
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "proxyMode" TEXT NOT NULL DEFAULT 'none',
    "proxyNetwork" TEXT NOT NULL DEFAULT 'deploynow',
    "proxyEmail" TEXT NOT NULL DEFAULT '',
    "proxyError" TEXT NOT NULL DEFAULT '',
    "proxyChallenge" TEXT NOT NULL DEFAULT 'http',
    "proxyDnsToken" TEXT NOT NULL DEFAULT '',
    "agentCertSerial" TEXT NOT NULL DEFAULT '',
    "agentJoinTokenHash" TEXT NOT NULL DEFAULT '',
    "agentJoinExpiresAt" DATETIME,
    "agentVersion" TEXT NOT NULL DEFAULT '',
    "agentHostname" TEXT NOT NULL DEFAULT '',
    "agentConnectedAt" DATETIME,
    "hostMetrics" TEXT NOT NULL DEFAULT '',
    "hostMetricsAt" DATETIME
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "githubUser" TEXT NOT NULL DEFAULT '',
    "githubToken" TEXT NOT NULL DEFAULT '',
    "pollingInterval" INTEGER NOT NULL DEFAULT 60,
    "autoUpdateLatest" BOOLEAN NOT NULL DEFAULT false,
    "require2faForAdmins" BOOLEAN NOT NULL DEFAULT true,
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
    "portainerUrl" TEXT NOT NULL DEFAULT '',
    "portainerApiKey" TEXT NOT NULL DEFAULT '',
    "portainerEndpointId" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "containerId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "registry" TEXT NOT NULL DEFAULT 'ghcr.io',
    "currentDigest" TEXT NOT NULL DEFAULT '',
    "repoDigests" TEXT NOT NULL DEFAULT '',
    "remoteDigest" TEXT NOT NULL DEFAULT '',
    "tag" TEXT NOT NULL DEFAULT 'latest',
    "isFloatingTag" BOOLEAN NOT NULL DEFAULT true,
    "arch" TEXT NOT NULL DEFAULT 'amd64',
    "status" TEXT NOT NULL DEFAULT 'unknown',
    "updateAvailable" BOOLEAN NOT NULL DEFAULT false,
    "endpointId" TEXT,
    "portainerEndpointId" INTEGER NOT NULL DEFAULT 1,
    "lastChecked" DATETIME,
    "lastUpdated" DATETIME,
    "lastHealthRestart" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Service_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HealthMonitor" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "prefixes" TEXT NOT NULL DEFAULT '',
    "logWindow" INTEGER NOT NULL DEFAULT 300,
    "cooldown" INTEGER NOT NULL DEFAULT 10,
    "logPatterns" TEXT NOT NULL DEFAULT 'connection timeout
connection refused
connection reset
connection timed out
unable to connect
pool exhausted
too many connections
out of memory
heap out of memory
oom killer
killed process
memory limit exceeded
fatal error
panic:
segfault
segmentation fault
core dumped
unhandled exception
deadlock detected
health check failed
no space left
i/o error
read-only file system'
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorType" TEXT NOT NULL DEFAULT 'system',
    "actorId" TEXT,
    "actorEmail" TEXT NOT NULL DEFAULT '',
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL DEFAULT '',
    "targetId" TEXT NOT NULL DEFAULT '',
    "endpointId" TEXT,
    "serviceId" TEXT,
    "ip" TEXT NOT NULL DEFAULT '',
    "outcome" TEXT NOT NULL DEFAULT 'success',
    "message" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT ''
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "serviceId" TEXT,
    "action" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Environment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "defaultEndpointId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Environment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Environment_defaultEndpointId_fkey" FOREIGN KEY ("defaultEndpointId") REFERENCES "Endpoint" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "environmentId" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "image" TEXT NOT NULL DEFAULT '',
    "gitRepo" TEXT NOT NULL DEFAULT '',
    "gitBranch" TEXT NOT NULL DEFAULT 'main',
    "buildContext" TEXT NOT NULL DEFAULT '.',
    "dockerfilePath" TEXT NOT NULL DEFAULT 'Dockerfile',
    "composePath" TEXT NOT NULL DEFAULT 'docker-compose.yml',
    "composeInline" TEXT NOT NULL DEFAULT '',
    "env" TEXT NOT NULL DEFAULT '[]',
    "ports" TEXT NOT NULL DEFAULT '[]',
    "volumes" TEXT NOT NULL DEFAULT '[]',
    "command" TEXT NOT NULL DEFAULT '',
    "restartPolicy" TEXT NOT NULL DEFAULT 'unless-stopped',
    "updatePolicy" TEXT NOT NULL DEFAULT 'manual',
    "webhookSecret" TEXT NOT NULL DEFAULT '',
    "previewsEnabled" BOOLEAN NOT NULL DEFAULT false,
    "previewDomain" TEXT NOT NULL DEFAULT '',
    "previewOfId" TEXT,
    "prNumber" INTEGER,
    "buildEndpointId" TEXT,
    "registryId" TEXT,
    "pullRegistryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'new',
    "currentDeploymentId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Application_environmentId_fkey" FOREIGN KEY ("environmentId") REFERENCES "Environment" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Application_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Deployment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "commitSha" TEXT NOT NULL DEFAULT '',
    "commitMessage" TEXT NOT NULL DEFAULT '',
    "imageRef" TEXT NOT NULL DEFAULT '',
    "imageDigest" TEXT NOT NULL DEFAULT '',
    "renderedCompose" TEXT NOT NULL DEFAULT '',
    "envSnapshot" TEXT NOT NULL DEFAULT '[]',
    "containerIds" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "startedById" TEXT,
    "startedByEmail" TEXT NOT NULL DEFAULT '',
    "rollbackOfId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    CONSTRAINT "Deployment_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Domain" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "path" TEXT NOT NULL DEFAULT '/',
    "containerPort" INTEGER NOT NULL,
    "service" TEXT NOT NULL DEFAULT '',
    "https" BOOLEAN NOT NULL DEFAULT true,
    "redirectTo" TEXT NOT NULL DEFAULT '',
    "redirectCode" INTEGER NOT NULL DEFAULT 308,
    "basicAuth" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Domain_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Job" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'queued',
    "runAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lockedBy" TEXT NOT NULL DEFAULT '',
    "lockedAt" DATETIME,
    "error" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME
);

-- CreateTable
CREATE TABLE "NotificationChannel" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "config" TEXT NOT NULL,
    "events" TEXT NOT NULL DEFAULT 'deploy.failure,deploy.success',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "lastError" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BackupDestination" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'r2',
    "endpointUrl" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "prefix" TEXT NOT NULL DEFAULT 'deploynow',
    "region" TEXT NOT NULL DEFAULT 'auto',
    "accessKeyId" TEXT NOT NULL,
    "secretKey" TEXT NOT NULL,
    "pruneKeyId" TEXT NOT NULL DEFAULT '',
    "pruneSecretKey" TEXT NOT NULL DEFAULT '',
    "objectLock" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "BackupRepo" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "destinationId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "initializedAt" DATETIME,
    "kitShownAt" DATETIME,
    "lastCheckAt" DATETIME,
    "lastCheckOk" BOOLEAN,
    "lastDrillAt" DATETIME,
    "lastDrillOk" BOOLEAN,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BackupRepo_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "BackupDestination" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BackupPolicy" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "endpointId" TEXT,
    "destinationId" TEXT NOT NULL,
    "sources" TEXT NOT NULL DEFAULT '[]',
    "mode" TEXT NOT NULL DEFAULT 'live',
    "preHook" TEXT NOT NULL DEFAULT '',
    "postHook" TEXT NOT NULL DEFAULT '',
    "schedule" TEXT NOT NULL DEFAULT '0 3 * * *',
    "keepDaily" INTEGER NOT NULL DEFAULT 7,
    "keepWeekly" INTEGER NOT NULL DEFAULT 4,
    "keepMonthly" INTEGER NOT NULL DEFAULT 6,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastStatus" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "BackupPolicy_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "BackupPolicy_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "BackupDestination" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "BackupRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "policyId" TEXT,
    "repoId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "params" TEXT NOT NULL DEFAULT '',
    "snapshots" TEXT NOT NULL DEFAULT '',
    "bytes" INTEGER NOT NULL DEFAULT 0,
    "log" TEXT NOT NULL DEFAULT '',
    "error" TEXT NOT NULL DEFAULT '',
    "actorEmail" TEXT NOT NULL DEFAULT '',
    "startedAt" DATETIME,
    "finishedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "BackupRun_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "BackupPolicy" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MetricSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cpus" INTEGER NOT NULL DEFAULT 0,
    "load1" REAL NOT NULL DEFAULT 0,
    "memTotal" REAL NOT NULL DEFAULT 0,
    "memUsed" REAL NOT NULL DEFAULT 0,
    "diskTotal" REAL NOT NULL DEFAULT 0,
    "diskUsed" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "MetricSample_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContainerSample" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "containerId" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL DEFAULT '',
    "service" TEXT NOT NULL DEFAULT '',
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "seconds" REAL NOT NULL DEFAULT 0,
    "cpuPercent" REAL NOT NULL DEFAULT 0,
    "netRx" REAL NOT NULL DEFAULT 0,
    "netTx" REAL NOT NULL DEFAULT 0,
    "blkRead" REAL NOT NULL DEFAULT 0,
    "blkWrite" REAL NOT NULL DEFAULT 0,
    "memUsage" REAL NOT NULL DEFAULT 0,
    "memLimit" REAL NOT NULL DEFAULT 0,
    "pids" INTEGER NOT NULL DEFAULT 0,
    "cpuSecondsTotal" REAL NOT NULL DEFAULT 0,
    "netRxTotal" REAL NOT NULL DEFAULT 0,
    "netTxTotal" REAL NOT NULL DEFAULT 0,
    "blkReadTotal" REAL NOT NULL DEFAULT 0,
    "blkWriteTotal" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "ContainerSample_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ContainerUsageHourly" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "endpointId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL DEFAULT '',
    "service" TEXT NOT NULL DEFAULT '',
    "hour" DATETIME NOT NULL,
    "samples" INTEGER NOT NULL DEFAULT 0,
    "seconds" REAL NOT NULL DEFAULT 0,
    "cpuAvg" REAL NOT NULL DEFAULT 0,
    "cpuMax" REAL NOT NULL DEFAULT 0,
    "memAvg" REAL NOT NULL DEFAULT 0,
    "memMax" REAL NOT NULL DEFAULT 0,
    "memLimit" REAL NOT NULL DEFAULT 0,
    "netRx" REAL NOT NULL DEFAULT 0,
    "netTx" REAL NOT NULL DEFAULT 0,
    "blkRead" REAL NOT NULL DEFAULT 0,
    "blkWrite" REAL NOT NULL DEFAULT 0,
    CONSTRAINT "ContainerUsageHourly_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL DEFAULT '',
    "message" TEXT NOT NULL,
    "firedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" DATETIME
);

-- CreateTable
CREATE TABLE "ScheduledTask" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "schedule" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'exec',
    "container" TEXT NOT NULL DEFAULT '',
    "image" TEXT NOT NULL DEFAULT '',
    "command" TEXT NOT NULL,
    "env" TEXT NOT NULL DEFAULT '',
    "timeoutSec" INTEGER NOT NULL DEFAULT 3600,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" DATETIME,
    "lastRunAt" DATETIME,
    "lastStatus" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ScheduledTask_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "Endpoint" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "TaskRun" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "taskId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "trigger" TEXT NOT NULL DEFAULT 'schedule',
    "exitCode" INTEGER,
    "log" TEXT NOT NULL DEFAULT '',
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    CONSTRAINT "TaskRun_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "ScheduledTask" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ApiToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'viewer',
    "expiresAt" DATETIME,
    "lastUsedAt" DATETIME,
    "lastUsedIp" TEXT NOT NULL DEFAULT '',
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ApiToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Passkey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "counter" INTEGER NOT NULL DEFAULT 0,
    "transports" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL DEFAULT 'Passkey',
    "rpId" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    CONSTRAINT "Passkey_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "SsoProvider" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "type" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "clientSecret" TEXT NOT NULL,
    "tenant" TEXT NOT NULL DEFAULT '',
    "issuer" TEXT NOT NULL DEFAULT '',
    "allowedDomains" TEXT NOT NULL DEFAULT '',
    "autoCreate" BOOLEAN NOT NULL DEFAULT false,
    "defaultRole" TEXT NOT NULL DEFAULT 'viewer',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "UserIdentity" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "providerId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "email" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    CONSTRAINT "UserIdentity_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "SsoProvider" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "UserIdentity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "AuthChallenge" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "userId" TEXT NOT NULL DEFAULT '',
    "data" TEXT NOT NULL DEFAULT '',
    "expiresAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "Registry" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "namespace" TEXT NOT NULL DEFAULT '',
    "ownerType" TEXT NOT NULL DEFAULT 'shared',
    "userId" TEXT,
    "projectId" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT '',
    "lastTestAt" DATETIME,
    "lastTestOk" BOOLEAN,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Registry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Registry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthClient" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL DEFAULT '',
    "name" TEXT NOT NULL,
    "redirectUris" TEXT NOT NULL,
    "tokenAuthMethod" TEXT NOT NULL DEFAULT 'none',
    "clientUri" TEXT NOT NULL DEFAULT '',
    "softwareId" TEXT NOT NULL DEFAULT '',
    "registeredIp" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "OAuthGrant" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" DATETIME,
    "lastUsedIp" TEXT NOT NULL DEFAULT '',
    "revokedAt" DATETIME,
    CONSTRAINT "OAuthGrant_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "OAuthClient" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "OAuthGrant_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthCode" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hash" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "usedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthCode_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "OAuthGrant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "OAuthToken" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "hash" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "grantId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "expiresAt" DATETIME NOT NULL,
    "revokedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OAuthToken_grantId_fkey" FOREIGN KEY ("grantId") REFERENCES "OAuthGrant" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "RecoveryCode_userId_idx" ON "RecoveryCode"("userId");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "RoleBinding_userId_scopeType_scopeId_key" ON "RoleBinding"("userId", "scopeType", "scopeId");

-- CreateIndex
CREATE UNIQUE INDEX "TeamInvite_token_key" ON "TeamInvite"("token");

-- CreateIndex
CREATE UNIQUE INDEX "Endpoint_name_key" ON "Endpoint"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Service_containerId_key" ON "Service"("containerId");

-- CreateIndex
CREATE INDEX "Service_endpointId_idx" ON "Service"("endpointId");

-- CreateIndex
CREATE INDEX "AuditEvent_createdAt_idx" ON "AuditEvent"("createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");

-- CreateIndex
CREATE INDEX "AuditEvent_endpointId_idx" ON "AuditEvent"("endpointId");

-- CreateIndex
CREATE UNIQUE INDEX "Project_name_key" ON "Project"("name");

-- CreateIndex
CREATE UNIQUE INDEX "Project_slug_key" ON "Project"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Environment_projectId_slug_key" ON "Environment"("projectId", "slug");

-- CreateIndex
CREATE INDEX "Application_environmentId_idx" ON "Application"("environmentId");

-- CreateIndex
CREATE UNIQUE INDEX "Application_endpointId_slug_key" ON "Application"("endpointId", "slug");

-- CreateIndex
CREATE INDEX "Deployment_applicationId_createdAt_idx" ON "Deployment"("applicationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Domain_host_path_key" ON "Domain"("host", "path");

-- CreateIndex
CREATE INDEX "Job_status_runAt_idx" ON "Job"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "BackupDestination_name_key" ON "BackupDestination"("name");

-- CreateIndex
CREATE UNIQUE INDEX "BackupRepo_destinationId_scope_key" ON "BackupRepo"("destinationId", "scope");

-- CreateIndex
CREATE INDEX "BackupPolicy_nextRunAt_idx" ON "BackupPolicy"("nextRunAt");

-- CreateIndex
CREATE INDEX "BackupRun_repoId_createdAt_idx" ON "BackupRun"("repoId", "createdAt");

-- CreateIndex
CREATE INDEX "BackupRun_policyId_createdAt_idx" ON "BackupRun"("policyId", "createdAt");

-- CreateIndex
CREATE INDEX "MetricSample_endpointId_at_idx" ON "MetricSample"("endpointId", "at");

-- CreateIndex
CREATE INDEX "ContainerSample_endpointId_key_at_idx" ON "ContainerSample"("endpointId", "key", "at");

-- CreateIndex
CREATE INDEX "ContainerSample_applicationId_at_idx" ON "ContainerSample"("applicationId", "at");

-- CreateIndex
CREATE INDEX "ContainerSample_at_idx" ON "ContainerSample"("at");

-- CreateIndex
CREATE INDEX "ContainerUsageHourly_applicationId_hour_idx" ON "ContainerUsageHourly"("applicationId", "hour");

-- CreateIndex
CREATE INDEX "ContainerUsageHourly_hour_idx" ON "ContainerUsageHourly"("hour");

-- CreateIndex
CREATE UNIQUE INDEX "ContainerUsageHourly_endpointId_key_hour_key" ON "ContainerUsageHourly"("endpointId", "key", "hour");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_key_key" ON "Alert"("key");

-- CreateIndex
CREATE INDEX "ScheduledTask_nextRunAt_idx" ON "ScheduledTask"("nextRunAt");

-- CreateIndex
CREATE INDEX "TaskRun_taskId_startedAt_idx" ON "TaskRun"("taskId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ApiToken_hash_key" ON "ApiToken"("hash");

-- CreateIndex
CREATE INDEX "ApiToken_userId_idx" ON "ApiToken"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Passkey_credentialId_key" ON "Passkey"("credentialId");

-- CreateIndex
CREATE UNIQUE INDEX "UserIdentity_providerId_subject_key" ON "UserIdentity"("providerId", "subject");

-- CreateIndex
CREATE INDEX "AuthChallenge_expiresAt_idx" ON "AuthChallenge"("expiresAt");

-- CreateIndex
CREATE INDEX "Registry_host_idx" ON "Registry"("host");

-- CreateIndex
CREATE INDEX "Registry_userId_idx" ON "Registry"("userId");

-- CreateIndex
CREATE INDEX "Registry_projectId_idx" ON "Registry"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthClient_clientId_key" ON "OAuthClient"("clientId");

-- CreateIndex
CREATE INDEX "OAuthGrant_userId_idx" ON "OAuthGrant"("userId");

-- CreateIndex
CREATE INDEX "OAuthGrant_clientId_idx" ON "OAuthGrant"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthCode_hash_key" ON "OAuthCode"("hash");

-- CreateIndex
CREATE UNIQUE INDEX "OAuthToken_hash_key" ON "OAuthToken"("hash");

-- CreateIndex
CREATE INDEX "OAuthToken_grantId_idx" ON "OAuthToken"("grantId");

