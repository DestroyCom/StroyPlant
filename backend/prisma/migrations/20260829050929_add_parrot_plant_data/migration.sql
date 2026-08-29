-- AlterTable
-- SQLite only allows exactly one ADD COLUMN per ALTER TABLE statement (unlike Postgres/MySQL),
-- so each new PlantProfile column below is its own statement.
ALTER TABLE "PlantProfile" ADD COLUMN "soilMoistureIrrigatePercent" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "soilMoistureCommandPercent" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "soilMoistureIrrigateEcoPercent" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "soilMoistureCommandEcoPercent" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "wetCalibrationSampleCount" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "irrigateCalibrationSampleCount" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "irrigateEcoCalibrationSampleCount" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "parrotSpeciesId" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "heightMinCm" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "heightMaxCm" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "spreadMinCm" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "spreadMaxCm" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "hardinessZoneMinValue" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "hardinessZoneMaxValue" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "heatZoneMinValue" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "heatZoneMaxValue" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "tDyingC" REAL;
ALTER TABLE "PlantProfile" ADD COLUMN "popularity" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "genusName" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "speciesName" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "subspeciesName" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "latinName" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "taxonomyGroupId" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "isTaxonomyGroupHead" BOOLEAN;
ALTER TABLE "PlantProfile" ADD COLUMN "taxonomyGroupSubelementsCount" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "tags" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "noFert" BOOLEAN;
ALTER TABLE "PlantProfile" ADD COLUMN "hidden" BOOLEAN;
ALTER TABLE "PlantProfile" ADD COLUMN "synonyms" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "nameFirstLetterLatin" TEXT;
ALTER TABLE "PlantProfile" ADD COLUMN "orderIndexForSortingLatin" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "sunCategory" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "waterCategory" INTEGER;
ALTER TABLE "PlantProfile" ADD COLUMN "fertilizerCategory" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "PlantProfile_parrotSpeciesId_key" ON "PlantProfile"("parrotSpeciesId");

-- CreateTable
CREATE TABLE "PlantProfileTranslation" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "plantProfileId" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "commonName" TEXT,
    "description" TEXT,
    "planting" TEXT,
    "growth" TEXT,
    "pruning" TEXT,
    "harvesting" TEXT,
    "interesting" TEXT,
    "soilIrr" TEXT,
    "pests" TEXT,
    "blooming" TEXT,
    "hardinessZoneMinText" TEXT,
    "hardinessZoneMaxText" TEXT,
    "heatZoneMinText" TEXT,
    "heatZoneMaxText" TEXT,
    "lightMinText" TEXT,
    "lightMaxText" TEXT,
    "fertilizerText" TEXT,
    "detailCare" TEXT,
    "nameFirstLetter" TEXT,
    "orderIndexForSorting" INTEGER,
    CONSTRAINT "PlantProfileTranslation_plantProfileId_fkey" FOREIGN KEY ("plantProfileId") REFERENCES "PlantProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlantProfileAttribute" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "plantProfileId" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    CONSTRAINT "PlantProfileAttribute_plantProfileId_fkey" FOREIGN KEY ("plantProfileId") REFERENCES "PlantProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlantProfileFertilizerType" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "plantProfileId" INTEGER NOT NULL,
    "code" INTEGER NOT NULL,
    CONSTRAINT "PlantProfileFertilizerType_plantProfileId_fkey" FOREIGN KEY ("plantProfileId") REFERENCES "PlantProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlantProfileSearchName" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "plantProfileId" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" INTEGER NOT NULL,
    CONSTRAINT "PlantProfileSearchName_plantProfileId_fkey" FOREIGN KEY ("plantProfileId") REFERENCES "PlantProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PlantAttributeNumberMapping" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "locale" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "number" INTEGER NOT NULL
);

-- CreateTable
CREATE TABLE "PlantProfileAttributeNumber" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "plantProfileId" INTEGER NOT NULL,
    "locale" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    CONSTRAINT "PlantProfileAttributeNumber_plantProfileId_fkey" FOREIGN KEY ("plantProfileId") REFERENCES "PlantProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "PlantProfileTranslation_plantProfileId_locale_key" ON "PlantProfileTranslation"("plantProfileId", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "PlantProfileAttribute_plantProfileId_category_value_key" ON "PlantProfileAttribute"("plantProfileId", "category", "value");

-- CreateIndex
CREATE INDEX "PlantProfileAttribute_category_value_idx" ON "PlantProfileAttribute"("category", "value");

-- CreateIndex
CREATE UNIQUE INDEX "PlantProfileFertilizerType_plantProfileId_code_key" ON "PlantProfileFertilizerType"("plantProfileId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PlantProfileSearchName_plantProfileId_locale_type_name_key" ON "PlantProfileSearchName"("plantProfileId", "locale", "type", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PlantAttributeNumberMapping_locale_code_key" ON "PlantAttributeNumberMapping"("locale", "code");

-- CreateIndex
CREATE UNIQUE INDEX "PlantProfileAttributeNumber_plantProfileId_locale_number_key" ON "PlantProfileAttributeNumber"("plantProfileId", "locale", "number");
