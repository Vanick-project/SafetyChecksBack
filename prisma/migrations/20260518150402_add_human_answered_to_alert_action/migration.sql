-- DropForeignKey
ALTER TABLE "AlertAction" DROP CONSTRAINT "AlertAction_alertId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "AlertAction_alertId_idx";

-- AlterTable: add new column
ALTER TABLE "AlertAction" ADD COLUMN "humanAnswered" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: safely cast actionType enum → TEXT (preserves existing data)
ALTER TABLE "AlertAction" ALTER COLUMN "actionType" TYPE TEXT USING "actionType"::TEXT;

-- AlterTable: drop executedAt default
ALTER TABLE "AlertAction" ALTER COLUMN "executedAt" DROP DEFAULT;

-- AddForeignKey
ALTER TABLE "AlertAction" ADD CONSTRAINT "AlertAction_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "AlertEvent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
