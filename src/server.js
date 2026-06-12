import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";

const app = createApp();
const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`LinkedIn Scheduled Poster listening on port ${port}`);
});

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received, shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
