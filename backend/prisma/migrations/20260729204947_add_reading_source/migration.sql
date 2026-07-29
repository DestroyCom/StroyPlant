-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Reading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "deviceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soilMoisturePercent" REAL,
    "temperatureC" REAL,
    "luminosity" REAL,
    "waterTankLevelPercent" REAL,
    "soilConductivityEcb" REAL,
    "soilConductivityEcPorous" REAL,
    "isDrySoil" BOOLEAN,
    "isWetSoil" BOOLEAN,
    "isEmptyTank" BOOLEAN,
    "isInAir" BOOLEAN,
    "humidityPercent" REAL,
    "batteryPercent" REAL,
    "source" TEXT NOT NULL DEFAULT 'POLL',
    CONSTRAINT "Reading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Reading" ("batteryPercent", "deviceId", "humidityPercent", "id", "isDrySoil", "isEmptyTank", "isInAir", "isWetSoil", "luminosity", "soilConductivityEcPorous", "soilConductivityEcb", "soilMoisturePercent", "temperatureC", "timestamp", "waterTankLevelPercent") SELECT "batteryPercent", "deviceId", "humidityPercent", "id", "isDrySoil", "isEmptyTank", "isInAir", "isWetSoil", "luminosity", "soilConductivityEcPorous", "soilConductivityEcb", "soilMoisturePercent", "temperatureC", "timestamp", "waterTankLevelPercent" FROM "Reading";
DROP TABLE "Reading";
ALTER TABLE "new_Reading" RENAME TO "Reading";
CREATE INDEX "Reading_deviceId_timestamp_idx" ON "Reading"("deviceId", "timestamp");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
