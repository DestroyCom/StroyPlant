-- CreateTable
CREATE TABLE "MqttSettings" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT DEFAULT 1,
    "url" TEXT,
    "username" TEXT,
    "password" TEXT,
    "discoveryPrefix" TEXT NOT NULL DEFAULT 'homeassistant',
    "baseTopic" TEXT NOT NULL DEFAULT 'stroyplant',
    "updatedAt" DATETIME NOT NULL
);
