-- CreateTable
CREATE TABLE "TonePreset" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "instruction" TEXT NOT NULL,
    "sampleText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TonePreset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TonePreset_userId_idx" ON "TonePreset"("userId");

-- AddForeignKey
ALTER TABLE "TonePreset" ADD CONSTRAINT "TonePreset_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
