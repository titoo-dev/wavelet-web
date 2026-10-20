-- CreateTable
CREATE TABLE "listen_event" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "artistId" TEXT,
    "albumId" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3) NOT NULL,
    "msPlayed" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "endReason" TEXT NOT NULL,
    "client" TEXT NOT NULL,
    "shuffle" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "listen_event_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "listen_event_userId_startedAt_idx" ON "listen_event"("userId", "startedAt" DESC);

-- CreateIndex
CREATE INDEX "listen_event_trackId_idx" ON "listen_event"("trackId");

-- AddForeignKey
ALTER TABLE "listen_event" ADD CONSTRAINT "listen_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
