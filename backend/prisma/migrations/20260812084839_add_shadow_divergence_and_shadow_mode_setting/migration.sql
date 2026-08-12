-- CreateTable
CREATE TABLE "ShadowDivergence" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "deviceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "legacyStatus" TEXT NOT NULL,
    "inferenceDiagnosisId" TEXT,
    "inferenceTier" TEXT,
    "inferenceSeverity" REAL,
    "inferenceConfidence" REAL,
    "recommendationAction" TEXT,
    "mainDifferences" JSONB NOT NULL,
    CONSTRAINT "ShadowDivergence_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HealthSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "baselineWindowDays" INTEGER NOT NULL DEFAULT 14,
    "warmupMinDays" INTEGER NOT NULL DEFAULT 3,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "shadowModeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_HealthSettings" ("baselineWindowDays", "id", "timezone", "updatedAt", "warmupMinDays") SELECT "baselineWindowDays", "id", "timezone", "updatedAt", "warmupMinDays" FROM "HealthSettings";
DROP TABLE "HealthSettings";
ALTER TABLE "new_HealthSettings" RENAME TO "HealthSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ShadowDivergence_deviceId_timestamp_idx" ON "ShadowDivergence"("deviceId", "timestamp");
