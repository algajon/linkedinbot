-- AlterEnum
ALTER TYPE "PostStatus" ADD VALUE 'PENDING_APPROVAL';

-- AlterTable
ALTER TABLE "ScheduledPost" ALTER COLUMN "scheduledAt" DROP NOT NULL;
ALTER TABLE "ScheduledPost" ADD COLUMN "origin" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "ScheduledPost" ADD COLUMN "approvedAt" TIMESTAMP(3);
ALTER TABLE "ScheduledPost" ADD COLUMN "contentSourceId" TEXT;

-- CreateTable
CREATE TABLE "ContentSource" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filename" TEXT,
    "extractedText" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostingRoutine" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "cadence" TEXT NOT NULL DEFAULT 'EVERY_24H',
    "timezone" TEXT NOT NULL DEFAULT 'UTC',
    "anchorTime" TEXT,
    "slots" JSONB,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PostingRoutine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentSource_userId_idx" ON "ContentSource"("userId");

-- CreateIndex
CREATE INDEX "PostingRoutine_userId_idx" ON "PostingRoutine"("userId");

-- AddForeignKey
ALTER TABLE "ContentSource" ADD CONSTRAINT "ContentSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostingRoutine" ADD CONSTRAINT "PostingRoutine_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
