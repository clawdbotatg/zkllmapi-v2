import "dotenv/config";
import express from "express";
import cors from "cors";
import { PORT, BUY_THRESHOLD, BUY_CHUNK } from "./config.js";
import { loadCredits, saveCredits, markSpent, getUnspentCredits } from "./credits.js";
import { preWarm, popProof, queueDepth, checkAndBuy } from "./prove.js";
import { callZkApi, callZkApiStart, callZkApiWithToken, buildOpenAIResponse, streamResponse } from "./adapter.js";
import { encryptChatRequest, decryptChatResponse, getE2EESession, isE2EEModel } from "./e2ee.js";
import { privateKeyToAccount } from "viem/accounts";
import { getPrivateKey } from "./config.js";

const app = express();
app.use(cors({
  exposedHeaders: ["x-conversation-balance", "x-conversation-ended", "x-e2ee"],
}));
app.use(express.json({ limit: "10mb" }));

const MODEL = "zai-org-glm-5";

// In-memory credit state
let credits = loadCredits();

function persistCredits() {
  saveCredits(credits);
}

// ─── GET /v1/models ───────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: [{ id: MODEL, object: "model", owned_by: "zkllmapi" }],
  });
});

// ─── POST /v1/conversation/end — abandon current session, start fresh next time
app.post("/v1/conversation/end", (_req, res) => {
  const tokenCredit = credits.find(
    (c) => !c.spent && c.token && (c.tokenBalance ?? 0) > 0 && (c.tokenExpiry ?? 0) > Date.now(),
  );
  if (tokenCredit) {
    const remaining = tokenCredit.tokenBalance?.toFixed(4) ?? "?";
    credits = markSpent(credits, tokenCredit.commitment);
    persistCredits();
    console.log(`[proxy] conversation ended by user — credit marked spent ($${remaining} remaining)`);
    res.json({ ended: true, balanceWas: tokenCredit.tokenBalance });
  } else {
    res.json({ ended: false, message: "no active conversation" });
  }

  checkAndBuy(() => credits, (newCredits) => {
    credits = [...credits, ...newCredits];
    persistCredits();
  }).catch(console.error);
});

// ─── GET /health ──────────────────────────────────────────────
app.get("/health", (_req, res) => {
  const unspent = getUnspentCredits(credits);
  res.json({
    status: "ok",
    wallet: privateKeyToAccount(getPrivateKey()).address,
    credits: {
      total: credits.length,
      unspent: unspent.length,
      spent: credits.length - unspent.length,
    },
    proofQueue: queueDepth(),
    thresholds: { buyThreshold: BUY_THRESHOLD, buyChunk: BUY_CHUNK },
  });
});

// ─── POST /v1/chat/completions ────────────────────────────────
app.post("/v1/chat/completions", async (req, res) => {
  const { messages, stream = false, model: requestedModel } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: { message: "messages is required", type: "invalid_request_error" } });
    return;
  }

  // Determine if E2EE mode is requested (e2ee- prefix triggers encryption)
  const e2eeMode = requestedModel ? isE2EEModel(requestedModel) : false;
  const targetModel = e2eeMode ? requestedModel!.replace(/^e2ee-/, "") : (requestedModel ?? MODEL);

  // E2EE: encrypt messages before sending to our server
  let e2eeActive = false;
  let callOptions: { model?: string; encryptedMessages?: string; e2eeHeaders?: Record<string, string> } = { model: targetModel };
  if (e2eeMode) {
    try {
      const { encryptedBody, e2eeHeaders } = await encryptChatRequest(req.body, targetModel);
      if (e2eeHeaders["X-Venice-TEE-Client-Pub-Key"]) {
        callOptions = {
          model: targetModel,
          encryptedMessages: encryptedBody.encrypted_messages,
          e2eeHeaders,
        };
        e2eeActive = true;
        console.log(`[e2ee] messages encrypted, client pubkey: ${e2eeHeaders["X-Venice-TEE-Client-Pub-Key"].slice(0, 16)}...`);
      } else {
        console.log(`[e2ee] attestation unavailable for ${targetModel} — sending without client-side encryption`);
      }
    } catch (err: any) {
      console.error(`[e2ee] setup failed: ${err.message} — sending without client-side encryption`);
    }
  }

  // ─── Mode 1: Find credit with valid conversation token ────
  const tokenCredit = credits.find(
    (c) =>
      !c.spent &&
      c.token &&
      (c.tokenBalance ?? 0) > 0 &&
      (c.tokenExpiry ?? 0) > Date.now(),
  );

  if (tokenCredit) {
    console.log(`[proxy] using conversation token (balance: $${tokenCredit.tokenBalance!.toFixed(4)}) ${e2eeActive ? "[E2EE 🔒]" : ""}`);

    let zkResponse: Response;
    try {
      zkResponse = await callZkApiWithToken(tokenCredit.token!, messages, stream, callOptions);
    } catch (err: any) {
      res.status(502).json({ error: { message: `ZK API unreachable: ${err.message}`, type: "server_error" } });
      return;
    }

    if (!zkResponse.ok) {
      if (zkResponse.status === 401 || zkResponse.status === 402) {
        // Token expired/depleted — clear it and retry with proof
        console.log(`[proxy] token expired/depleted (${zkResponse.status}) — will start new conversation`);
        credits = markSpent(credits, tokenCredit.commitment);
        persistCredits();
        // Fall through to proof-based flow below
      } else {
        const errBody = await zkResponse.json().catch(() => ({}));
        res.status(zkResponse.status).json({
          error: { message: (errBody as any).error ?? "ZK API error", type: "server_error" },
        });
        return;
      }
    } else {
      // Update token balance from response headers
      const balance = zkResponse.headers.get("x-conversation-balance");
      const ended = zkResponse.headers.get("x-conversation-ended");

      if (balance !== null) {
        tokenCredit.tokenBalance = parseFloat(balance);
      }
      if (ended === "true") {
        credits = markSpent(credits, tokenCredit.commitment);
        console.log(`[proxy] conversation ended — credit marked spent`);
      }
      persistCredits();

      // Forward balance + E2EE headers to the caller
      if (balance !== null) res.setHeader("x-conversation-balance", balance);
      if (ended === "true") res.setHeader("x-conversation-ended", "true");
      if (e2eeActive) res.setHeader("x-e2ee", "true");

      if (stream) {
        await streamResponse(zkResponse, res, targetModel);
      } else {
        let data = await zkResponse.json();
        if (e2eeActive) {
          try {
            const session = await getE2EESession(targetModel);
            data = decryptChatResponse(data, session);
            console.log(`[e2ee] response decrypted ✅`);
          } catch (err: any) {
            console.error(`[e2ee] response decryption failed:`, err.message);
          }
        }
        res.json(buildOpenAIResponse(data, targetModel));
      }

      // Trigger background replenishment if needed
      checkAndBuy(() => credits, (newCredits) => {
        credits = [...credits, ...newCredits];
        persistCredits();
      }).catch(console.error);
      return;
    }
  }

  // ─── Mode 2: Proof-based flow (start new conversation) ────
  // Get a ready proof
  let proof = popProof();

  if (!proof) {
    const unspent = getUnspentCredits(credits);
    if (unspent.length === 0) {
      res.status(503).json({
        error: {
          message: "No credits available. Proxy is buying more — try again in ~30 seconds.",
          type: "service_unavailable",
        },
      });
      checkAndBuy(() => credits, (newCredits) => {
        credits = [...credits, ...newCredits];
        persistCredits();
      }).catch(console.error);
      return;
    }

    console.log("[proxy] no pre-warmed proof available — generating on demand (slow)...");
    const { generateProof } = await import("./prove.js");
    try {
      proof = await generateProof(unspent[0]);
    } catch (err: any) {
      res.status(500).json({ error: { message: `Proof generation failed: ${err.message}`, type: "server_error" } });
      return;
    }
  }

  console.log(`[proxy] starting new conversation with commitment ${proof.commitment.slice(0, 12)}... ${e2eeActive ? "[E2EE 🔒]" : ""}`);

  // Use /v1/chat/start for single-RTT: proof + first message → token + response
  let zkResponse: Response;
  try {
    zkResponse = await callZkApiStart(proof, messages, callOptions);
  } catch (err: any) {
    res.status(502).json({ error: { message: `ZK API unreachable: ${err.message}`, type: "server_error" } });
    return;
  }

  if (!zkResponse.ok) {
    const errBody = await zkResponse.json().catch(() => ({}));
    res.status(zkResponse.status).json({
      error: { message: (errBody as any).error ?? "ZK API error", type: "server_error" },
    });
    return;
  }

  const startData = await zkResponse.json();

  // Store conversation token on the credit
  const credit = credits.find((c) => c.commitment === proof!.commitment);
  if (credit) {
    credit.token = startData.token;
    credit.tokenBalance = startData.balanceRemaining;
    credit.tokenExpiry = startData.expiresAt;
    persistCredits();
  }

  console.log(`[proxy] conversation started — token issued, balance: $${startData.balanceRemaining?.toFixed(4)}`);

  // Forward balance + E2EE headers to the caller
  if (startData.balanceRemaining != null) res.setHeader("x-conversation-balance", String(startData.balanceRemaining));
  if (e2eeActive) res.setHeader("x-e2ee", "true");

  // Return the embedded Venice response (or error if Venice failed)
  if (startData.response) {
    let data = startData.response;
    if (e2eeActive) {
      try {
        const session = await getE2EESession(targetModel);
        data = decryptChatResponse(data, session);
        console.log(`[e2ee] response decrypted ✅`);
      } catch (err: any) {
        console.error(`[e2ee] response decryption failed:`, err.message);
      }
    }
    res.json(buildOpenAIResponse(data, targetModel));
  } else {
    // Venice failed but token was issued — return an error response
    res.status(502).json({
      error: {
        message: startData.veniceError ?? "Venice failed during conversation start — retry your message",
        type: "server_error",
      },
    });
  }

  // Trigger background replenishment
  checkAndBuy(() => credits, (newCredits) => {
    credits = [...credits, ...newCredits];
    persistCredits();
  }).catch(console.error);
});

// ─── Startup ──────────────────────────────────────────────────
async function startup() {
  const account = privateKeyToAccount(getPrivateKey());
  console.log(`🔐 zkllmapi-proxy starting...`);
  console.log(`   Wallet: ${account.address}`);
  console.log(`   Credits loaded: ${credits.length} total, ${getUnspentCredits(credits).length} unspent`);
  console.log(`   Auto-buy: when < ${BUY_THRESHOLD} unspent, buy ${BUY_CHUNK}`);

  await checkAndBuy(() => credits, (newCredits) => {
    credits = [...credits, ...newCredits];
    persistCredits();
  });

  const unspent = getUnspentCredits(credits);
  if (unspent.length > 0) {
    console.log(`[startup] pre-warming proofs for ${unspent.length} credits in background...`);
    preWarm(unspent).catch(console.error);
  }

  app.listen(PORT, () => {
    console.log(`\n✅ Proxy listening on http://localhost:${PORT}`);
    console.log(`   OpenAI base URL: http://localhost:${PORT}/v1`);
    console.log(`   Point your agent at: http://localhost:${PORT}`);
  });
}

startup().catch(err => {
  console.error("Fatal startup error:", err);
  process.exit(1);
});
