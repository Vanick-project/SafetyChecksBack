/*
  Warnings:

  - You are about to drop the column `lastCheckInAt` on the `User` table. All the data in the column will be lost.
  - The `status` column on the `User` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the `CheckIn` table. If the table is not empty, all the data it contains will be lost.
  - A unique constraint covering the columns `[phoneNumber]` on the table `User` will be added. If there are existing duplicate values, this will fail.
  - Added the required column `address` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `city` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `country` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `phoneNumber` to the `User` table without a default value. This is not possible if the table is not empty.
  - Added the required column `zipCode` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'PAUSED', 'DELETED');

-- CreateEnum
CREATE TYPE "CheckInResponse" AS ENUM ('OK', 'SOS');

-- CreateEnum
CREATE TYPE "AlertReason" AS ENUM ('NO_RESPONSE_AFTER_2_ATTEMPTS', 'USER_PRESSED_SOS');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('ACTIVE', 'RESOLVED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ActionType" AS ENUM ('CALL', 'SMS', 'PUSH');

-- DropForeignKey
ALTER TABLE "CheckIn" DROP CONSTRAINT "CheckIn_userId_fkey";

-- AlterTable
ALTER TABLE "User" DROP COLUMN "lastCheckInAt",
ADD COLUMN     "address" TEXT NOT NULL,
ADD COLUMN     "city" TEXT NOT NULL,
ADD COLUMN     "country" TEXT NOT NULL,
ADD COLUMN     "fcmToken" TEXT,
ADD COLUMN     "lastLat" DOUBLE PRECISION,
ADD COLUMN     "lastLng" DOUBLE PRECISION,
ADD COLUMN     "phoneNumber" TEXT NOT NULL,
ADD COLUMN     "zipCode" TEXT NOT NULL,
ALTER COLUMN "firstName" DROP NOT NULL,
DROP COLUMN "status",
ADD COLUMN     "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE';

-- DropTable
DROP TABLE "CheckIn";

-- CreateTable
CREATE TABLE "CheckInEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),
    "response" "CheckInResponse",
    "attemptNumber" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "CheckInEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "triggerReason" "AlertReason" NOT NULL,
    "triggeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "status" "AlertStatus" NOT NULL DEFAULT 'ACTIVE',
    "latAtTrigger" DOUBLE PRECISION NOT NULL,
    "lngAtTrigger" DOUBLE PRECISION NOT NULL,

    CONSTRAINT "AlertEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertAction" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "actionType" "ActionType" NOT NULL,
    "destination" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "providerSid" TEXT,
    "executedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CheckInEvent_userId_idx" ON "CheckInEvent"("userId");

-- CreateIndex
CREATE INDEX "AlertEvent_userId_idx" ON "AlertEvent"("userId");

-- CreateIndex
CREATE INDEX "AlertAction_alertId_idx" ON "AlertAction"("alertId");

-- CreateIndex
CREATE UNIQUE INDEX "User_phoneNumber_key" ON "User"("phoneNumber");

-- AddForeignKey
ALTER TABLE "CheckInEvent" ADD CONSTRAINT "CheckInEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertEvent" ADD CONSTRAINT "AlertEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlertAction" ADD CONSTRAINT "AlertAction_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "AlertEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
