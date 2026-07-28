-- CreateTable
CREATE TABLE "Schedule" (
    "deviceId" TEXT NOT NULL PRIMARY KEY,
    "active" BOOLEAN NOT NULL,
    "allowedStartHour" INTEGER NOT NULL,
    "allowedEndHour" INTEGER NOT NULL,
    "cooldownHours" INTEGER NOT NULL,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Schedule_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
