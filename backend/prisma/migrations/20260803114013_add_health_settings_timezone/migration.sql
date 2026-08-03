-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_HealthSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "baselineWindowDays" INTEGER NOT NULL DEFAULT 14,
    "warmupMinDays" INTEGER NOT NULL DEFAULT 3,
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_HealthSettings" ("baselineWindowDays", "id", "updatedAt", "warmupMinDays") SELECT "baselineWindowDays", "id", "updatedAt", "warmupMinDays" FROM "HealthSettings";
DROP TABLE "HealthSettings";
ALTER TABLE "new_HealthSettings" RENAME TO "HealthSettings";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
