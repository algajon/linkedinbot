-- AlterTable: per-author fine-tune targets.
ALTER TABLE "TonePreset" ADD COLUMN "openaiModel" TEXT;
ALTER TABLE "TonePreset" ADD COLUMN "dgxLora" TEXT;
