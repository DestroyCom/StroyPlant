-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL,
    "name" TEXT,
    "lastSeenAt" DATETIME
);

-- CreateTable
CREATE TABLE "Reading" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "deviceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "soilMoisturePercent" REAL,
    "temperatureC" REAL,
    "luminosity" REAL,
    "waterTankLevelPercent" REAL,
    "humidityPercent" REAL,
    "batteryPercent" REAL,
    CONSTRAINT "Reading_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "WateringEvent" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "deviceId" TEXT NOT NULL,
    "timestamp" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "triggerSource" TEXT NOT NULL,
    "success" BOOLEAN NOT NULL,
    "errorDetail" TEXT,
    CONSTRAINT "WateringEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "Reading_deviceId_timestamp_idx" ON "Reading"("deviceId", "timestamp");

-- CreateIndex
CREATE INDEX "WateringEvent_deviceId_timestamp_idx" ON "WateringEvent"("deviceId", "timestamp");
