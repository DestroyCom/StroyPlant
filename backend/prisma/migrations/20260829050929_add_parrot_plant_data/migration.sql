-- AlterTable
ALTER TABLE "PlantProfile" ADD COLUMN "soilMoistureIrrigatePercent" REAL,
ADD COLUMN "soilMoistureCommandPercent" REAL,
ADD COLUMN "soilMoistureIrrigateEcoPercent" REAL,
ADD COLUMN "soilMoistureCommandEcoPercent" REAL,
ADD COLUMN "wetCalibrationSampleCount" INTEGER,
ADD COLUMN "irrigateCalibrationSampleCount" INTEGER,
ADD COLUMN "irrigateEcoCalibrationSampleCount" INTEGER,
ADD COLUMN "parrotSpeciesId" INTEGER,
ADD COLUMN "heightMinCm" REAL,
ADD COLUMN "heightMaxCm" REAL,
ADD COLUMN "spreadMinCm" REAL,
ADD COLUMN "spreadMaxCm" REAL,
ADD COLUMN "hardinessZoneMinValue" TEXT,
ADD COLUMN "hardinessZoneMaxValue" TEXT,
ADD COLUMN "heatZoneMinValue" TEXT,
ADD COLUMN "heatZoneMaxValue" TEXT,
ADD COLUMN "tDyingC" REAL,
ADD COLUMN "popularity" INTEGER,
ADD COLUMN "genusName" TEXT,
ADD COLUMN "speciesName" TEXT,
ADD COLUMN "subspeciesName" TEXT,
ADD COLUMN "latinName" TEXT,
ADD COLUMN "taxonomyGroupId" INTEGER,
ADD COLUMN "isTaxonomyGroupHead" BOOLEAN,
ADD COLUMN "taxonomyGroupSubelementsCount" INTEGER,
ADD COLUMN "tags" INTEGER,
ADD COLUMN "noFert" BOOLEAN,
ADD COLUMN "hidden" BOOLEAN,
ADD COLUMN "synonyms" TEXT,
ADD COLUMN "nameFirstLetterLatin" TEXT,
ADD COLUMN "orderIndexForSortingLatin" INTEGER,
ADD COLUMN "sunCategory" INTEGER,
ADD COLUMN "waterCategory" INTEGER,
ADD COLUMN "fertilizerCategory" INTEGER;

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
