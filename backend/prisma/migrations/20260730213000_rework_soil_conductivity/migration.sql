-- RedefineTables
-- Replaces soilConductivityEcb/soilConductivityEcPorous (39e1fa0d/0e, confirmed unreadable on real
-- Parrot Pot firmware) with soilConductivityUsCm (decoded from the raw 39e1fa02 characteristic,
-- see backend/src/ble/parrot/soilConductivity.ts). Old values are not carried over — they were
-- collected from a different, unconfirmed characteristic and don't represent the same measurement.
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
    "soilConductivityUsCm" REAL,
    "isDrySoil" BOOLEAN,
    "isWetSoil" BOOLEAN,
    "isEmptyTank" BOOLEAN,
    "isInAir" BOOLEAN,
    "humidityPercent" REAL,
    "batteryPercent" REAL,
    "source" TEXT NOT NULL DEFAULT 'POLL',
    CONSTRAINT "Reading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Reading" ("batteryPercent", "deviceId", "humidityPercent", "id", "isDrySoil", "isEmptyTank", "isInAir", "isWetSoil", "luminosity", "soilMoisturePercent", "temperatureC", "timestamp", "waterTankLevelPercent", "source") SELECT "batteryPercent", "deviceId", "humidityPercent", "id", "isDrySoil", "isEmptyTank", "isInAir", "isWetSoil", "luminosity", "soilMoisturePercent", "temperatureC", "timestamp", "waterTankLevelPercent", "source" FROM "Reading";
DROP TABLE "Reading";
ALTER TABLE "new_Reading" RENAME TO "Reading";
CREATE INDEX "Reading_deviceId_timestamp_idx" ON "Reading"("deviceId", "timestamp");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
