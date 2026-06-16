CREATE TABLE "RecentTopic" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "query" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RecentTopic_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecentTopic_userId_query_key" ON "RecentTopic"("userId", "query");
CREATE INDEX "RecentTopic_userId_idx" ON "RecentTopic"("userId");
ALTER TABLE "RecentTopic" ADD CONSTRAINT "RecentTopic_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
