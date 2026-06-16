-- CreateTable
CREATE TABLE "NewsWatch" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "query" TEXT NOT NULL,
    "tonePresetId" TEXT,
    "stance" TEXT,
    "language" TEXT NOT NULL DEFAULT 'en',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "seenUrls" JSONB,
    "lastRunAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "NewsWatch_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "NewsWatch_userId_idx" ON "NewsWatch"("userId");
ALTER TABLE "NewsWatch" ADD CONSTRAINT "NewsWatch_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
