/**
 * cli-chat.ts — Lightweight CLI chat that talks through the local proxy.
 *
 * The proxy handles credit buying, ZK proofs, and E2EE encryption.
 * This just sends OpenAI-compatible requests to localhost:3100.
 *
 * Usage:
 *   yarn chat            # start chatting (proxy must be running)
 */

import "dotenv/config";
import { createInterface } from "readline";

const PROXY_URL = process.env.PROXY_URL ?? "http://localhost:3100";
const MODEL = "e2ee-zai-org-glm-5";

const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

const history: { role: string; content: string }[] = [];
let balance: number | null = null;

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY ?? false,
});

let closed = false;
rl.on("close", () => { closed = true; });

function ask(q: string): Promise<string> {
  if (closed) return Promise.resolve("/quit");
  return new Promise(res => {
    rl.question(q, answer => res(answer));
  });
}

async function getHealth(): Promise<any> {
  const res = await fetch(`${PROXY_URL}/health`);
  return res.json();
}

function statusLine(): string {
  const parts: string[] = [];
  if (balance !== null) parts.push(`$${balance.toFixed(4)} remaining`);
  return parts.length ? `${DIM}   ${parts.join(" · ")}${RESET}` : "";
}

async function sendMessage(userText: string): Promise<string> {
  history.push({ role: "user", content: userText });

  const res = await fetch(`${PROXY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, messages: history, stream: false }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Proxy error (${res.status}): ${body}`);
  }

  const data = await res.json();

    const balanceHeader = res.headers.get("x-conversation-balance");
  const ended = res.headers.get("x-conversation-ended");
  const e2eeHeader = res.headers.get("x-e2ee");

  if (balanceHeader !== null) balance = parseFloat(balanceHeader);

  const content = data.choices?.[0]?.message?.content ?? "(no response)";
  history.push({ role: "assistant", content });

  const usage = data.usage;
  const meta: string[] = [];
  meta.push(e2eeHeader === "true" ? "🔒 e2ee" : "🔓 no e2ee");
  if (usage) meta.push(`${usage.prompt_tokens}in/${usage.completion_tokens ?? 0}out`);
  if (balance !== null) meta.push(`$${balance.toFixed(4)} remaining`);

  if (meta.length) process.stdout.write(`${DIM}   ${meta.join(" · ")}${RESET}\n`);

  if (ended === "true") {
    balance = 0;
    process.stdout.write(`${YELLOW}   ⚠ session ended — balance depleted${RESET}\n`);
  }

  return content;
}

async function main() {
  let health: any;
  try {
    health = await getHealth();
  } catch {
    console.error(`\n❌ Proxy not running at ${PROXY_URL}`);
    console.error(`   Start it first:  yarn proxy:dev\n`);
    process.exit(1);
  }

  console.clear();
  console.log("🔐 zkllmapi chat · e2ee");
  console.log(`   Proxy:    ${PROXY_URL}`);
  console.log(`   Model:    ${MODEL.replace(/^e2ee-/, "")} (e2ee encrypted)`);
  console.log(`   Wallet:   ${health.wallet}`);
  console.log(`   Credits:  ${health.credits.unspent} unspent / ${health.credits.total} total`);
  console.log(`   Proofs:   ${health.proofQueue} pre-warmed`);
  console.log(`   Budget:   $0.05 per credit`);
  console.log("");
  console.log("   /new    new credit + session   /clear  clear history   /quit  exit\n");

  if (health.credits.unspent === 0 && health.proofQueue === 0) {
    console.log("   ⏳ No credits — proxy is buying, wait a moment and try again.\n");
  }

  while (true) {
    const input = await ask(`${CYAN}you:${RESET} `);
    const trimmed = input.trim();
    if (!trimmed) continue;

    if (trimmed === "/quit" || trimmed === "/q") {
      console.log("\n👋 bye\n");
      rl.close();
      break;
    }

    if (trimmed === "/new" || trimmed === "/n") {
      try {
        const endRes = await fetch(`${PROXY_URL}/v1/conversation/end`, { method: "POST" });
        const endData = await endRes.json();
        history.length = 0;
        balance = null;
        if (endData.ended) {
          console.log(`   🔄 session ended ($${endData.balanceWas?.toFixed(4)} forfeited) — next message uses a new credit\n`);
        } else {
          console.log("   🔄 no active session — next message starts fresh\n");
        }
      } catch {
        console.log("   ❌ proxy unreachable\n");
      }
      continue;
    }

    if (trimmed === "/clear" || trimmed === "/c") {
      history.length = 0;
      console.log("   🗑  history cleared (same credit, balance unchanged)\n");
      continue;
    }

    if (trimmed === "/health" || trimmed === "/s") {
      try {
        const h = await getHealth();
        const bal = balance !== null ? ` · $${balance.toFixed(4)} remaining` : "";
        console.log(`   💳 ${h.credits.unspent} credits · ${h.proofQueue} proofs · 🔒 e2ee${bal}\n`);
      } catch {
        console.log("   ❌ proxy unreachable\n");
      }
      continue;
    }

    try {
      const response = await sendMessage(trimmed);
      console.log(`\n${GREEN}🧠 ${response}${RESET}\n`);
    } catch (e: any) {
      console.error(`\n❌ ${e.message}\n`);
      history.pop();
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
