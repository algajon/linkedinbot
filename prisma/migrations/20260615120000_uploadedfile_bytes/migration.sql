-- AlterTable: store image bytes in the DB so uploads survive ephemeral hosts.
ALTER TABLE "UploadedFile" ADD COLUMN "data" BYTEA;
