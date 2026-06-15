// OpenAI fine-tuning CLI for per-author "topic post" voice.
// NOTHING here runs automatically and nothing is launched without you typing
// the command — `launch` is the only step that spends money.
//
// Usage:
//   node scripts/fineTune.js export  "<preset name>" [out.jsonl]
//   node scripts/fineTune.js launch  <out.jsonl> ["<preset name>"]
//   node scripts/fineTune.js status  <jobId> ["<preset name>"]
//
// Flow: export -> launch (prints a job id) -> status (writes the resulting
// fine_tuned_model id onto the preset.openaiModel; the app then uses it
// automatically for topic generation with that voice).

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/lib/prisma.js";
import { parseExemplars } from "../src/services/ai.service.js";

const OPENAI = "https://api.openai.com/v1";
const BASE_MODEL = process.env.OPENAI_FT_BASE || "gpt-4o-mini-2024-07-18";

// Rotated generic user prompts so the model learns the VOICE, not one prompt.
const USER_PROMPTS = [
  "Write a LinkedIn post in your authentic voice.",
  "Share a short update with your network.",
  "Post a reflection or lesson from your work.",
  "Write a LinkedIn post about something on your mind today.",
];

function key() {
  const k = process.env.OPENAI_API_KEY;
  if (!k) throw new Error("OPENAI_API_KEY is not set.");
  return k;
}

async function getPreset(name) {
  const p = await prisma.tonePreset.findFirst({ where: { name: { contains: name } } });
  if (!p) throw new Error(`No tone preset matching "${name}".`);
  return p;
}

async function cmdExport(name, outArg) {
  const preset = await getPreset(name);
  const posts = parseExemplars(preset.sampleText);
  if (posts.length < 10) {
    console.warn(`! Only ${posts.length} examples — OpenAI suggests 50+. Proceeding anyway.`);
  }
  const system =
    `You write LinkedIn posts in one specific person's voice.\n${preset.instruction}\n` +
    "Never use em dashes, markdown, bullet or numbered lists, or generic filler hashtags.";
  const lines = posts.map((post, i) =>
    JSON.stringify({
      messages: [
        { role: "system", content: system },
        { role: "user", content: USER_PROMPTS[i % USER_PROMPTS.length] },
        { role: "assistant", content: post },
      ],
    })
  );
  const out = outArg || path.join("fine-tune", `${preset.name.replace(/[^a-z0-9]+/gi, "_").toLowerCase()}.jsonl`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, lines.join("\n") + "\n");
  console.log(`Wrote ${lines.length} training examples -> ${out}`);
  console.log(`Next: node scripts/fineTune.js launch ${out} "${preset.name}"`);
}

async function cmdLaunch(file) {
  const buf = fs.readFileSync(file);
  const form = new FormData();
  form.append("purpose", "fine-tune");
  form.append("file", new Blob([buf], { type: "application/jsonl" }), path.basename(file));
  const up = await fetch(`${OPENAI}/files`, { method: "POST", headers: { Authorization: `Bearer ${key()}` }, body: form });
  if (!up.ok) throw new Error(`file upload failed: ${up.status} ${await up.text()}`);
  const { id: training_file } = await up.json();
  const job = await fetch(`${OPENAI}/fine_tuning/jobs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ training_file, model: BASE_MODEL }),
  });
  if (!job.ok) throw new Error(`job create failed: ${job.status} ${await job.text()}`);
  const j = await job.json();
  console.log(`Fine-tune job created: ${j.id} (model ${BASE_MODEL}). This costs money on your key.`);
  console.log(`Track: node scripts/fineTune.js status ${j.id} "<preset name>"`);
}

async function cmdStatus(jobId, name) {
  const res = await fetch(`${OPENAI}/fine_tuning/jobs/${jobId}`, { headers: { Authorization: `Bearer ${key()}` } });
  if (!res.ok) throw new Error(`status failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  console.log(`status: ${j.status}` + (j.fine_tuned_model ? ` | model: ${j.fine_tuned_model}` : ""));
  if (j.status === "succeeded" && j.fine_tuned_model && name) {
    const preset = await getPreset(name);
    await prisma.tonePreset.update({ where: { id: preset.id }, data: { openaiModel: j.fine_tuned_model } });
    console.log(`Saved openaiModel onto preset "${preset.name}". Topic generation will now use it.`);
  }
}

const [cmd, a, b] = process.argv.slice(2);
const run = { export: () => cmdExport(a, b), launch: () => cmdLaunch(a), status: () => cmdStatus(a, b) }[cmd];
if (!run) {
  console.log("Commands: export <presetName> [out.jsonl] | launch <file.jsonl> [presetName] | status <jobId> [presetName]");
  process.exit(1);
}
run()
  .catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
