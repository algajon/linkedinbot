import { PrismaClient } from "@prisma/client";

// Single shared Prisma client for the web process.
export const prisma = new PrismaClient();
