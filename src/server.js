import "dotenv/config";
import { createApp } from "./app.js";
import { prisma } from "./lib/prisma.js";
import { isSchedulerEnabled, startPublishScheduler, stopPublishScheduler } from "./scheduler.js";

const app = createApp();
const port = process.env.PORT || 3000;

const server = app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`LinkedIn Scheduled Poster listening on port ${port}`);
  // Run the publisher in-process (hourly by default) unless disabled.
  if (isSchedulerEnabled()) {
    startPublishScheduler();
  }
});

async function shutdown(signal) {
  // eslint-disable-next-line no-console
  console.log(`\n${signal} received, shutting down...`);
  stopPublishScheduler();
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
