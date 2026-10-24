-- CreateTable
CREATE TABLE "story_render" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "trackId" TEXT NOT NULL,
    "theme" TEXT NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "linesHash" TEXT NOT NULL,
    "lines" JSONB NOT NULL,
    "title" TEXT NOT NULL,
    "artist" TEXT NOT NULL,
    "coverUrl" TEXT,
    "trackDurationMs" INTEGER NOT NULL,
    "nextLineMs" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "progress" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "storagePath" TEXT,
    "size" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "readyAt" TIMESTAMP(3),

    CONSTRAINT "story_render_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "story_render_userId_createdAt_idx" ON "story_render"("userId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "story_render_userId_trackId_theme_startMs_endMs_linesHash_idx" ON "story_render"("userId", "trackId", "theme", "startMs", "endMs", "linesHash");

-- CreateIndex
CREATE INDEX "story_render_status_updatedAt_idx" ON "story_render"("status", "updatedAt");

-- AddForeignKey
ALTER TABLE "story_render" ADD CONSTRAINT "story_render_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

