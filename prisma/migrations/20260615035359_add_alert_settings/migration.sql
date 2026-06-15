-- AlterTable
ALTER TABLE "User" ADD COLUMN     "alertChannel" TEXT NOT NULL DEFAULT 'sms',
ADD COLUMN     "alertSystemEnabled" BOOLEAN NOT NULL DEFAULT true;
