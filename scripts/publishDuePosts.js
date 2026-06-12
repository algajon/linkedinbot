// Cron entrypoint: find due posts and publish them, then exit.
// Run by the Render Cron Job every minute: `node scripts/publishDuePosts.js`
import "dotenv/config";
import { prisma } from "../src/lib/prisma.js";
import { runPublishDuePosts } from "../src/services/postScheduler.service.js";

runPublishDuePosts()
  .then((summary) => {
    // eslint-disable-next-line no-console
    console.log(
      `[publishDuePosts] reclaimed=${summary.reclaimed} attempted=${summary.attempted} ` +
        `published=${summary.published} failed=${summary.failed}`
    );
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error("[publishDuePosts] fatal:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
