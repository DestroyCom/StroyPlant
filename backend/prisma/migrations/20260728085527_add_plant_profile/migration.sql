-- CreateTable
CREATE TABLE "PlantProfile" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "name" TEXT NOT NULL,
    "commonName" TEXT,
    "soilMoistureMinPercent" REAL,
    "soilMoistureMaxPercent" REAL,
    "soilConductivityMinUsCm" REAL,
    "soilConductivityMaxUsCm" REAL,
    "soilPhMin" REAL,
    "soilPhMax" REAL,
    "temperatureMinC" REAL,
    "temperatureMaxC" REAL,
    "humidityMinPercent" REAL,
    "humidityMaxPercent" REAL,
    "lightMinLux" REAL,
    "lightMaxLux" REAL,
    "lightMinMmol" REAL,
    "lightMaxMmol" REAL
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "lastSeenAt" DATETIME,
    "plantProfileId" INTEGER,
    CONSTRAINT "Device_plantProfileId_fkey" FOREIGN KEY ("plantProfileId") REFERENCES "PlantProfile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Device" ("id", "kind", "lastSeenAt", "name") SELECT "id", "kind", "lastSeenAt", "name" FROM "Device";
DROP TABLE "Device";
ALTER TABLE "new_Device" RENAME TO "Device";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "PlantProfile_name_key" ON "PlantProfile"("name");
