-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "lastSeenAt" DATETIME,
    "location" TEXT,
    "environment" TEXT,
    "autonomousWateringActive" BOOLEAN NOT NULL DEFAULT false,
    "autonomousWateringUpdatedAt" DATETIME,
    "plantProfileId" INTEGER,
    CONSTRAINT "Device_plantProfileId_fkey" FOREIGN KEY ("plantProfileId") REFERENCES "PlantProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Device" ("environment", "id", "kind", "lastSeenAt", "location", "name", "plantProfileId") SELECT "environment", "id", "kind", "lastSeenAt", "location", "name", "plantProfileId" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
