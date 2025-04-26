/*
  Warnings:

  - Added the required column `status` to the `Log` table without a default value. This is not possible if the table is not empty.

*/
-- AlterTable
ALTER TABLE "Log" ADD COLUMN     "status" "RepositoryStatus" NOT NULL;
