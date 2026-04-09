-- AlterEnum
ALTER TYPE "ActionType" ADD VALUE 'USER_RESOLVED';

-- AlterEnum
ALTER TYPE "AlertReason" ADD VALUE 'NO_RESPONSE_AFTER_3_REMINDERS';

-- AlterEnum
ALTER TYPE "AlertStatus" ADD VALUE 'FAILED';

-- AlterTable
ALTER TABLE "AlertEvent" ALTER COLUMN "latAtTrigger" DROP NOT NULL,
ALTER COLUMN "lngAtTrigger" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "lastCheckInAt" TIMESTAMP(3);
