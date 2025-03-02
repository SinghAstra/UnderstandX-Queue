/*
  Warnings:

  - You are about to drop the column `longSummary` on the `File` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "File" DROP COLUMN "longSummary",
ADD COLUMN     "analysis" TEXT;

-- AlterTable
ALTER TABLE "Repository" ALTER COLUMN "overview" DROP NOT NULL;
