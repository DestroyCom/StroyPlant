-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Schedule" (
    "deviceId" TEXT NOT NULL PRIMARY KEY,
    "active" BOOLEAN NOT NULL,
    "allowedStartHour" INTEGER NOT NULL,
    "allowedEndHour" INTEGER NOT NULL,
    "cooldownHours" INTEGER NOT NULL,
    "wateringMode" TEXT NOT NULL DEFAULT 'PERFECT_DROP',
    "customVwcIrrPercent" REAL,
    "customVwcCmdPercent" REAL,
    "customNIrrDays" INTEGER,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Schedule_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
INSERT INTO "new_Schedule" ("active", "allowedEndHour", "allowedStartHour", "cooldownHours", "deviceId", "updatedAt") SELECT "active", "allowedEndHour", "allowedStartHour", "cooldownHours", "deviceId", "updatedAt" FROM "Schedule";
DROP TABLE "Schedule";
ALTER TABLE "new_Schedule" RENAME TO "Schedule";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
