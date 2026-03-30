import "dotenv/config";
import express from "express";
import cors from "cors";
import { PORT, BUY_THRESHOLD, BUY_CHUNK } from "./config.js";
import { loadCredits, saveCredits, markSpent, getUnspentCredits } from "./credits.js";
import { preWarm, popProof, queueDepth, checkAndBuy } from "./prove.js";
import { callZkApiStart, callZkApiWithToken, buildOpenAIResponse, streamResponse } from "./adapter.js";
import { encryptChatRequest, decryptResponseChunks, isE2EEModel, isHexEncrypted, decryptChunk } from "./e2ee.js";
import type { E2EESession } from "./e2ee.js";
import { privateKeyToAccount } from "viem/accounts";
import { getPrivateKey } from "./config.js";

const app = express();
app.use(cors({
  exposedHeaders: ["x-conversation-balance", "x-conversation-ended", "x-e2ee"],
}));
app.use(express.json({ limit: "10mb" }));

const MODEL = "zai-org-glm-5";

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

// ─── POST /v1/conversation/end ────────────────────────────────
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

/**
 * Decrypt Venice response data if E2EE is active.
 * Handles both `encrypted_chunks` array (from backend SSE aggregation)
 * and single hex-encrypted content.
 */
function decryptVeniceResponse(data: any, session: E2EESession): any {
  if (data.encrypted_chunks && Array.isArray(data.encrypted_chunks)) {
    const plaintext = decryptResponseChunks(data.encrypted_chunks, session);
    console.log(`[e2ee] response decrypted (${data.encrypted_chunks.length} chunks) ✅`);
    return {
      ...data,
      encrypted_chunks: undefined,
      choices: [{
        index: 0,
        message: { role: "assistant", content: plaintext },
        finish_reason: data.choices?.[0]?.finish_reason ?? "stop",
      }],
    };
  }

  const content = data.choices?.[0]?.message?.content;
  if (content && isHexEncrypted(content)) {
    try {
      const plaintext = decryptChunk(content, session.clientPrivateKey);
      console.log(`[e2ee] response decrypted (single content) ✅`);
      return {
        ...data,
        choices: [{
          ...data.choices[0],
          message: { ...data.choices[0].message, content: plaintext },
        }],
      };
    } catch (err: any) {
      console.error(`[e2ee] content decryption failed: ${err.message}`);
    }
  }

  return data;
}

// ─── POST /v1/chat/completions ────────────────────────────────
app.post("/v1/chat/completions", async (req, res) => {
  const { messages, stream = false, model: requestedModel } = req.body;

  if (!messages || !Array.isArray(messages)) {
    res.status(400).json({ error: { message: "messages is required", type: "invalid_request_error" } });
    return;
  }

  const e2eeMode = requestedModel ? isE2EEModel(requestedModel) : false;
  // For E2EE, keep the e2ee- prefix — the backend needs it to select the right Venice model
  const targetModel = e2eeMode ? requestedModel! : (requestedModel ?? MODEL);

  let e2eeActive = false;
  let e2eeSession: E2EESession | null = null;
  let callMessages = messages;
  let callOptions: { model?: string; e2eeHeaders?: Record<string, string> } = { model: targetModel };

  if (e2eeMode) {
    const result = await encryptChatRequest(messages, targetModel);
    if (result) {
      callMessages = result.encryptedMessages;
      callOptions = { model: targetModel, e2eeHeaders: result.e2eeHeaders };
      e2eeSession = result.session;
      e2eeActive = true;
    } else {
      console.log(`[e2ee] encryption unavailable for ${targetModel} — sending plaintext`);
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
      zkResponse = await callZkApiWithToken(tokenCredit.token!, callMessages, stream, callOptions);
    } catch (err: any) {
      res.status(502).json({ error: { message: `ZK API unreachable: ${err.message}`, type: "server_error" } });
      return;
    }

    if (!zkResponse.ok) {
      if (zkResponse.status === 401 || zkResponse.status === 402) {
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
      const balance = zkResponse.headers.get("x-conversation-balance");
      const ended = zkResponse.headers.get("x-conversation-ended");

      if (balance !== null) tokenCredit.tokenBalance = parseFloat(balance);
      if (ended === "true") {
        credits = markSpent(credits, tokenCredit.commitment);
        console.log(`[proxy] conversation ended — credit marked spent`);
      }
      persistCredits();

      if (balance !== null) res.setHeader("x-conversation-balance", balance);
      if (ended === "true") res.setHeader("x-conversation-ended", "true");
      if (e2eeActive) res.setHeader("x-e2ee", "true");

      if (stream) {
        await streamResponse(zkResponse, res, targetModel);
      } else {
        let data = await zkResponse.json();
        if (e2eeActive && e2eeSession) {
          data = decryptVeniceResponse(data, e2eeSession);
        }
        res.json(buildOpenAIResponse(data, targetModel));
      }

      checkAndBuy(() => credits, (newCredits) => {
        credits = [...credits, ...newCredits];
        persistCredits();
      }).catch(console.error);
      return;
    }
  }

  // ─── Mode 2: Proof-based flow (start new conversation) ────
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

  let zkResponse: Response;
  try {
    zkResponse = await callZkApiStart(proof, callMessages, callOptions);
  } catch (err: any) {
    res.status(502).json({ error: { message: `ZK API unreachable: ${err.message}`, type: "server_error" } });
    return;
  }

  if (!zkResponse.ok) {
    const errBody = await zkResponse.json().catch(() => ({}));
    const errMsg = (errBody as any).error ?? "ZK API error";

    if (zkResponse.status === 403) {
      console.log(`[proxy] proof rejected for ${proof.commitment.slice(0, 12)}: ${errMsg} — marking spent and retrying`);
      credits = markSpent(credits, proof.commitment);
      persistCredits();

      let nextProof = popProof();
      if (!nextProof) {
        const remaining = getUnspentCredits(credits);
        if (remaining.length > 0) {
          console.log(`[proxy] no pre-warmed proof — generating fresh proof for ${remaining[0].commitment.slice(0, 12)}...`);
          const { generateProof } = await import("./prove.js");
          try { nextProof = await generateProof(remaining[0]); } catch {}
        }
      }

      if (nextProof) {
        console.log(`[proxy] retrying with proof: ${nextProof.commitment.slice(0, 12)}...`);
        try {
          const retryResponse = await callZkApiStart(nextProof, callMessages, callOptions);
          if (retryResponse.ok) {
            const retryData = await retryResponse.json();
            const retryCred = credits.find((c) => c.commitment === nextProof!.commitment);
            if (retryCred) {
              retryCred.token = retryData.token;
              retryCred.tokenBalance = retryData.balanceRemaining;
              retryCred.tokenExpiry = retryData.expiresAt;
              persistCredits();
            }
            console.log(`[proxy] retry succeeded — balance: $${retryData.balanceRemaining?.toFixed(4)}`);
            if (retryData.balanceRemaining != null) res.setHeader("x-conversation-balance", String(retryData.balanceRemaining));
            if (e2eeActive) res.setHeader("x-e2ee", "true");
            if (retryData.response) {
              let data = retryData.response;
              if (e2eeActive && e2eeSession) {
                data = decryptVeniceResponse(data, e2eeSession);
              }
              res.json(buildOpenAIResponse(data, targetModel));
            } else {
              res.status(502).json({ error: { message: retryData.veniceError ?? "Venice failed on retry", type: "server_error" } });
            }
            checkAndBuy(() => credits, (nc) => { credits = [...credits, ...nc]; persistCredits(); }).catch(console.error);
            return;
          }
          const retryErr = await retryResponse.json().catch(() => ({}));
          res.status(retryResponse.status).json({ error: { message: (retryErr as any).error ?? "ZK API error on retry", type: "server_error" } });
        } catch (retryErr: any) {
          res.status(502).json({ error: { message: `Retry failed: ${retryErr.message}`, type: "server_error" } });
        }
      } else {
        res.status(503).json({ error: { message: "Credit was stale and no backup proofs ready — try again in ~30 seconds.", type: "service_unavailable" } });
      }
      checkAndBuy(() => credits, (nc) => { credits = [...credits, ...nc]; persistCredits(); }).catch(console.error);
      return;
    }

    res.status(zkResponse.status).json({
      error: { message: errMsg, type: "server_error" },
    });
    return;
  }

  const startData = await zkResponse.json();

  const credit = credits.find((c) => c.commitment === proof!.commitment);
  if (credit) {
    credit.token = startData.token;
    credit.tokenBalance = startData.balanceRemaining;
    credit.tokenExpiry = startData.expiresAt;
    persistCredits();
  }

  console.log(`[proxy] conversation started — token issued, balance: $${startData.balanceRemaining?.toFixed(4)}`);

  if (startData.balanceRemaining != null) res.setHeader("x-conversation-balance", String(startData.balanceRemaining));
  if (e2eeActive) res.setHeader("x-e2ee", "true");

  if (startData.response) {
    let data = startData.response;
    if (e2eeActive && e2eeSession) {
      data = decryptVeniceResponse(data, e2eeSession);
    }
    res.json(buildOpenAIResponse(data, targetModel));
  } else {
    res.status(502).json({
      error: {
        message: startData.veniceError ?? "Venice failed during conversation start — retry your message",
        type: "server_error",
      },
    });
  }

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
