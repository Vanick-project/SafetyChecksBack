-- DropForeignKey
ALTER TABLE "AlertAction" DROP CONSTRAINT "AlertAction_alertId_fkey";

-- AlterTable
ALTER TABLE "AlertAction" ALTER COLUMN "destination" DROP NOT NULL,
ALTER COLUMN "executedAt" SET DEFAULT CURRENT_TIMESTAMP;

-- DropEnum
DROP TYPE "ActionType";

-- CreateIndex
CREATE INDEX "AlertAction_alertId_idx" ON "AlertAction"("alertId");

-- AddForeignKey
ALTER TABLE "AlertAction" ADD CONSTRAINT "AlertAction_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "AlertEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;
