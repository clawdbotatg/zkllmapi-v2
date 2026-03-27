"use client";

import { useEffect, useRef, useState } from "react";
import type { NextPage } from "next";
import externalContracts from "~~/contracts/externalContracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://backend.zkllmapi.com";

// ⚠️ Use addresses from externalContracts — NEVER hardcode stale addresses
const API_CREDITS_ADDRESS = externalContracts[8453].APICredits.address;

interface StoredCredit {
  nullifier: string;
  secret: string;
  commitment: string;
  leafIndex: number;
  spent: boolean;
}

const ChatMessage = {
  system: (content: string): ChatMessage => ({ role: "system", content }),
  user: (content: string): ChatMessage => ({ role: "user", content }),
  assistant: (content: string): ChatMessage => ({ role: "assistant", content }),
};

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

// System prompt injected into every conversation so the model knows about ZK LLM API
const SYSTEM_PROMPT = `You are running inside the ZK LLM API chat interface at zkllmapi.com — a private, anonymous LLM API powered by zero-knowledge proofs on Base mainnet.

Key facts about this project:
- Model: zai-org-glm-5 (Z.AI's flagship, 198K context, reasoning-capable)
- Hash function: Poseidon2 (ZK-friendly, used for Merkle tree and nullifier hashing)
- How it works: Users stake CLAWD tokens, register a Poseidon2 commitment on-chain, then generate a ZK proof in-browser to start a conversation anonymously. 1 credit = 1 conversation with a $1.00 balance. The ZK proof burns once at conversation start; subsequent messages use a bearer token until the balance is depleted.
- Privacy: The server verifies the proof but never learns the user's nullifier or secret. Each conversation starts with a fresh nullifier burn — there is no cryptographic link between separate conversations.
- Contract addresses (Base mainnet): APICredits=0x5954..., CLAWDPricing=0x445D..., CLAWDRouter=0xCB42..., CLAWD token=0x9f86dB9fc6f7c9408e8Fda3Ff8ce4e78ac7a6b07
- Website: https://zkllmapi.com | GitHub: https://github.com/clawdbotatg/zk-api-credits

Answer questions about this project accurately. If asked about hash functions, cryptography, ZK proofs, or how the system works, explain clearly.`;

const MODEL = "zai-org-glm-5";

const CIRCUIT_URL = `${API_URL}/circuit`;
const PROOF_DEPTH = 16;

// localStorage keys for conversation token
const TOKEN_KEY = "zk-conversation-token";
const TOKEN_BALANCE_KEY = "zk-conversation-balance";
const TOKEN_EXPIRY_KEY = "zk-conversation-expiry";

interface TreeData {
  leaves: string[];
  levels: string[][];
  root: string;
  depth: number;
  zeros: string[];
}

/**
 * Compute the Merkle sibling path for a commitment from full tree data.
 * Called client-side so the server never learns which commitment is being used.
 */
function computeMerklePath(treeData: TreeData, commitment: string) {
  const leafIndex = treeData.leaves.findIndex(l => l === commitment);
  if (leafIndex === -1) return null;

  const { levels, depth, zeros, root } = treeData;
  const siblings: string[] = [];
  const indices: number[] = [];
  let currentIndex = leafIndex;

  for (let i = 0; i < PROOF_DEPTH; i++) {
    if (i < depth) {
      const siblingIndex = currentIndex ^ 1;
      siblings.push(levels[i][siblingIndex]);
    } else {
      siblings.push(zeros[i]);
    }
    indices.push((leafIndex >> i) & 1);
    currentIndex = currentIndex >> 1;
  }

  return { leafIndex, siblings, indices, root, depth };
}

const ChatPage: NextPage = () => {
  const [credits, setCredits] = useState<StoredCredit[]>([]);
  const [message, setMessage] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [proofStatus, setProofStatus] = useState("");
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Conversation token state
  const [conversationToken, setConversationToken] = useState<string | null>(null);
  const [tokenBalance, setTokenBalance] = useState<number>(0);
  const [tokenExpiry, setTokenExpiry] = useState<number>(0);
  const [conversationEnded, setConversationEnded] = useState(false);

  const availableCredits = credits.filter(c => !c.spent);
  const hasActiveConversation = conversationToken && tokenBalance > 0 && tokenExpiry > Date.now();

  // Load credits + persisted chat history + conversation token from localStorage
  useEffect(() => {
    try {
      const stored = localStorage.getItem(`zk-credits-${API_CREDITS_ADDRESS}`);
      if (stored) setCredits(JSON.parse(stored));
      const history = localStorage.getItem(`zk-chat-history-${API_CREDITS_ADDRESS}`);
      if (history) setMessages(JSON.parse(history));

      // Load conversation token
      const savedToken = localStorage.getItem(TOKEN_KEY);
      const savedBalance = localStorage.getItem(TOKEN_BALANCE_KEY);
      const savedExpiry = localStorage.getItem(TOKEN_EXPIRY_KEY);
      if (savedToken && savedBalance && savedExpiry) {
        const expiry = parseInt(savedExpiry, 10);
        if (expiry > Date.now()) {
          setConversationToken(savedToken);
          setTokenBalance(parseFloat(savedBalance));
          setTokenExpiry(expiry);
        } else {
          // Expired — clear
          localStorage.removeItem(TOKEN_KEY);
          localStorage.removeItem(TOKEN_BALANCE_KEY);
          localStorage.removeItem(TOKEN_EXPIRY_KEY);
        }
      }
    } catch (e) {
      console.error("Failed to load from localStorage:", e);
    }
  }, []);

  // Persist chat history whenever messages change
  useEffect(() => {
    if (messages.length > 0) {
      localStorage.setItem(`zk-chat-history-${API_CREDITS_ADDRESS}`, JSON.stringify(messages));
    }
  }, [messages]);

  const clearChat = () => {
    setMessages([]);
    setConversationToken(null);
    setTokenBalance(0);
    setTokenExpiry(0);
    setConversationEnded(false);
    localStorage.removeItem(`zk-chat-history-${API_CREDITS_ADDRESS}`);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_BALANCE_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
  };

  const startNewConversation = () => {
    setConversationEnded(false);
    setConversationToken(null);
    setTokenBalance(0);
    setTokenExpiry(0);
    setMessages([]);
    localStorage.removeItem(`zk-chat-history-${API_CREDITS_ADDRESS}`);
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(TOKEN_BALANCE_KEY);
    localStorage.removeItem(TOKEN_EXPIRY_KEY);
  };

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  /**
   * Send message using existing conversation token (no proof needed)
   */
  const sendWithToken = async (allMessages: ChatMessage[]) => {
    setProofStatus("Sending message...");

    const apiRes = await fetch(`${API_URL}/v1/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${conversationToken}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [ChatMessage.system(SYSTEM_PROMPT), ...allMessages],
      }),
    });

    if (!apiRes.ok) {
      if (apiRes.status === 401 || apiRes.status === 402) {
        // Token expired/depleted — prompt new conversation
        setConversationEnded(true);
        setConversationToken(null);
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(TOKEN_BALANCE_KEY);
        localStorage.removeItem(TOKEN_EXPIRY_KEY);
        throw new Error("Conversation ended — your balance is depleted. Start a new conversation to continue.");
      }
      const errText = await apiRes.text();
      throw new Error(`API error (${apiRes.status}): ${errText}`);
    }

    // Update balance from headers
    const balance = apiRes.headers.get("x-conversation-balance");
    const ended = apiRes.headers.get("x-conversation-ended");

    if (balance !== null) {
      const newBalance = parseFloat(balance);
      setTokenBalance(newBalance);
      localStorage.setItem(TOKEN_BALANCE_KEY, balance);
    }

    if (ended === "true") {
      setConversationEnded(true);
      setConversationToken(null);
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(TOKEN_BALANCE_KEY);
      localStorage.removeItem(TOKEN_EXPIRY_KEY);
    }

    const apiData = await apiRes.json();
    return apiData.choices?.[0]?.message?.content || apiData.response || "No response";
  };

  /**
   * Start a new conversation: generate ZK proof → POST /v1/chat/start → get token + response
   */
  const sendWithProof = async (userMessage: string, allMessages: ChatMessage[]) => {
    // Find a valid credit (same flow as before)
    const { Barretenberg: BB2, Fr: Fr2 } = await import("@aztec/bb.js");
    const bbCheck = await BB2.new({ threads: 1 });
    const frToBI = (fr: { value: Uint8Array }) =>
      BigInt(
        "0x" +
          Array.from(fr.value)
            .map((b: number) => b.toString(16).padStart(2, "0"))
            .join(""),
      );

    let creditToUse: (typeof availableCredits)[0] | null = null;
    const staleCredits: string[] = [];

    // Fetch the full tree once
    const treeRes = await fetch(`${API_URL}/tree`);
    if (!treeRes.ok) throw new Error("Failed to fetch tree data");
    const treeData: TreeData = await treeRes.json();
    const treeLeafSet = new Set(treeData.leaves);

    // Compute all nullifier hashes upfront
    const nullifierHashes = new Map<string, string>();
    for (const credit of availableCredits) {
      if (!treeLeafSet.has(credit.commitment)) {
        staleCredits.push(credit.commitment);
        continue;
      }
      const nullifierHash = frToBI(await bbCheck.poseidon2Hash([new Fr2(BigInt(credit.nullifier))]));
      nullifierHashes.set(credit.commitment, "0x" + nullifierHash.toString(16).padStart(64, "0"));
    }
    await bbCheck.destroy();

    // Check all nullifiers in parallel
    const creditsToCheck = availableCredits.filter(c => nullifierHashes.has(c.commitment));
    if (creditsToCheck.length > 0) {
      const spentResults = await Promise.all(
        creditsToCheck.map(c => fetch(`${API_URL}/nullifier/${nullifierHashes.get(c.commitment)}`).then(r => r.json())),
      );
      for (let i = 0; i < creditsToCheck.length; i++) {
        if (spentResults[i].spent) {
          staleCredits.push(creditsToCheck[i].commitment);
        } else if (!creditToUse) {
          creditToUse = creditsToCheck[i];
        }
      }
    }

    // Mark stale credits as spent
    if (staleCredits.length > 0) {
      const updated = credits.map(c => (staleCredits.includes(c.commitment) ? { ...c, spent: true } : c));
      setCredits(updated);
      localStorage.setItem(`zk-credits-${API_CREDITS_ADDRESS}`, JSON.stringify(updated));
    }

    if (!creditToUse) {
      throw new Error("No valid unspent credits found. Please buy a new one on the Buy page.");
    }

    // Generate ZK proof
    setProofStatus("Fetching current root...");
    const healthRes = await fetch(`${API_URL}/health`);
    await healthRes.json();

    setProofStatus("Loading ZK circuit (this may take a moment)...");
    const circuitRes = await fetch(CIRCUIT_URL);
    const circuit = await circuitRes.json();

    setProofStatus("Initializing proof system...");
    const { Noir } = await import("@noir-lang/noir_js");
    const { UltraHonkBackend, Barretenberg, Fr } = await import("@aztec/bb.js");

    const bb = await Barretenberg.new({ threads: 1 });
    const noir = new Noir(circuit);
    const backend = new UltraHonkBackend(circuit.bytecode);

    const frToBigInt = (fr: { value: Uint8Array }) =>
      BigInt(
        "0x" +
          Array.from(fr.value)
            .map((b: number) => b.toString(16).padStart(2, "0"))
            .join(""),
      );

    const nullifierBig = BigInt(creditToUse.nullifier);
    const nullifierHash = frToBigInt(await bb.poseidon2Hash([new Fr(nullifierBig)]));

    const merkleData = computeMerklePath(treeData, creditToUse.commitment);
    if (!merkleData) throw new Error("Commitment not found in tree");

    setProofStatus("Generating ZK proof (takes 10-30s)...");

    const { witness } = await noir.execute({
      nullifier_hash: nullifierHash.toString(),
      root: merkleData.root,
      depth: merkleData.depth,
      nullifier: creditToUse.nullifier,
      secret: creditToUse.secret,
      indices: merkleData.indices.map(String),
      siblings: merkleData.siblings.map(String),
    });

    const { proof: proofBytes } = await backend.generateProof(witness);
    await bb.destroy();

    setProofStatus("Starting conversation...");

    const proofHex =
      "0x" +
      Array.from(proofBytes)
        .map((b: number) => b.toString(16).padStart(2, "0"))
        .join("");
    const nullifierHashHex = "0x" + nullifierHash.toString(16).padStart(64, "0");
    const rootHex = "0x" + BigInt(merkleData.root).toString(16).padStart(64, "0");

    // POST to /v1/chat/start — single round trip: proof + first message → token + response
    const apiRes = await fetch(`${API_URL}/v1/chat/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        proof: proofHex,
        nullifier_hash: nullifierHashHex,
        root: rootHex,
        depth: merkleData.depth,
        model: MODEL,
        messages: [ChatMessage.system(SYSTEM_PROMPT), ...allMessages],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      if (apiRes.status === 403 && errText.includes("already spent")) {
        const updatedCredits = credits.map(c => (c.commitment === creditToUse!.commitment ? { ...c, spent: true } : c));
        setCredits(updatedCredits);
        localStorage.setItem(`zk-credits-${API_CREDITS_ADDRESS}`, JSON.stringify(updatedCredits));
        throw new Error("This credit was already used. Please buy a new one on the Buy page.");
      }
      throw new Error(`API error (${apiRes.status}): ${errText}`);
    }

    const apiData = await apiRes.json();

    // Store conversation token
    if (apiData.token) {
      setConversationToken(apiData.token);
      setTokenBalance(apiData.balanceRemaining ?? 1.0);
      setTokenExpiry(apiData.expiresAt ?? Date.now() + 86400 * 1000);
      localStorage.setItem(TOKEN_KEY, apiData.token);
      localStorage.setItem(TOKEN_BALANCE_KEY, String(apiData.balanceRemaining ?? 1.0));
      localStorage.setItem(TOKEN_EXPIRY_KEY, String(apiData.expiresAt ?? Date.now() + 86400 * 1000));
    }

    // Mark credit as spent (nullifier is burned — but token is active)
    const updatedCredits = credits.map(c => (c.commitment === creditToUse!.commitment ? { ...c, spent: true } : c));
    setCredits(updatedCredits);
    localStorage.setItem(`zk-credits-${API_CREDITS_ADDRESS}`, JSON.stringify(updatedCredits));

    // Return the Venice response
    if (apiData.response) {
      return apiData.response.choices?.[0]?.message?.content || "No response";
    } else if (apiData.veniceError) {
      throw new Error(`Venice error: ${apiData.veniceError}. Token issued — retry your message.`);
    }
    return "No response";
  };

  const handleSend = async () => {
    if (!message.trim()) return;
    if (!hasActiveConversation && availableCredits.length === 0) {
      setError("No available credits. Go to the Buy page to purchase more.");
      return;
    }

    setIsSending(true);
    setError(null);
    setConversationEnded(false);
    const userMessage = message.trim();
    setMessage("");
    const newMessages = [...messages, { role: "user" as const, content: userMessage }];
    setMessages(newMessages);

    try {
      let assistantMessage: string;

      if (hasActiveConversation) {
        // Use existing token — no proof needed
        assistantMessage = await sendWithToken(newMessages);
      } else {
        // Start new conversation with ZK proof
        assistantMessage = await sendWithProof(userMessage, newMessages);
      }

      setMessages(prev => [...prev, { role: "assistant", content: assistantMessage }]);
      setProofStatus("");
    } catch (e: any) {
      console.error("Chat error:", e);
      setError(e?.message || "Failed to send message");
      setProofStatus("");
    } finally {
      setIsSending(false);
    }
  };

  return (
    <div
      className="flex flex-col relative"
      style={{
        height: "calc(100vh - 56px)",
        backgroundImage: "url(/hero-chat.jpg)",
        backgroundSize: "cover",
        backgroundPosition: "center top",
      }}
    >
      <div className="absolute inset-0 bg-black/75" />
      <div className="relative z-10 flex flex-col h-full">
        {/* Top bar */}
        <div className="border-b border-[#1f1f1f] px-6 py-3 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-4">
            <span className="text-sm font-mono font-bold">ZK CHAT</span>
            <span className="text-xs font-mono text-base-content/30">·</span>
            <span className="text-xs font-mono text-base-content/50">zai-org-glm-5</span>
          </div>
          <div className="flex items-center gap-4">
            {hasActiveConversation && (
              <span className="text-xs font-mono text-[#42F38F]/60">💰 ${tokenBalance.toFixed(4)}</span>
            )}
            <span className="text-xs font-mono text-base-content/30">
              {availableCredits.length} credit
              {availableCredits.length !== 1 ? "s" : ""} left
            </span>
            {messages.length > 0 && (
              <button
                className="cursor-pointer text-xs font-mono text-base-content/20 hover:text-error transition-colors"
                onClick={clearChat}
              >
                CLEAR
              </button>
            )}
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 py-6">
          {messages.length === 0 && !isSending && !conversationEnded && (
            <div className="flex items-center justify-center h-full">
              <div className="text-center">
                <p className="text-xs font-mono text-base-content/20 tracking-widest mb-3">PRIVATE LLM TERMINAL</p>
                <p className="font-mono text-base-content/40 text-sm mb-1">
                  Your identity is hidden behind a ZK proof.
                </p>
                <p className="font-mono text-base-content/20 text-xs">
                  {availableCredits.length === 0
                    ? "→ Go to /buy to get credits first"
                    : hasActiveConversation
                      ? `Active conversation · $${tokenBalance.toFixed(4)} remaining`
                      : `${availableCredits.length} credit${availableCredits.length !== 1 ? "s" : ""} ready · 1 credit = 1 conversation ($1.00)`}
                </p>
              </div>
            </div>
          )}

          {availableCredits.length > 0 && availableCredits.length <= 5 && (
            <div className="max-w-3xl mx-auto mb-4">
              <div className="border border-yellow-500/20 bg-yellow-500/5 px-4 py-2 text-center">
                <span className="text-xs font-mono text-yellow-500/70">
                  ⚠️ Small anonymity set — privacy improves as more people use the system
                </span>
              </div>
            </div>
          )}

          <div className="max-w-3xl mx-auto space-y-6">
            {messages
              .filter(msg => msg.role !== "system")
              .map((msg, i) => (
                <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div className={`max-w-[80%] ${msg.role === "user" ? "" : ""}`}>
                    <p
                      className={`text-xs font-mono mb-2 ${msg.role === "user" ? "text-right text-base-content/30" : "text-[#42F38F]/60"}`}
                    >
                      {msg.role === "user" ? "YOU" : "zai-org-glm-5"}
                    </p>
                    <div
                      className={`font-mono text-sm leading-relaxed whitespace-pre-wrap px-4 py-3 border ${
                        msg.role === "user"
                          ? "border-primary/20 bg-primary/5 text-base-content/80 text-right"
                          : "border-[#222] bg-[#111] text-base-content/80"
                      }`}
                    >
                      {msg.content}
                    </div>
                  </div>
                </div>
              ))}

            {/* Conversation ended prompt */}
            {conversationEnded && (
              <div className="flex justify-center">
                <div className="border border-[#333] bg-[#111] px-6 py-4 text-center">
                  <p className="text-xs font-mono text-base-content/40 mb-3">Conversation balance depleted.</p>
                  {availableCredits.length > 0 ? (
                    <button
                      className="cursor-pointer text-xs font-mono text-primary hover:text-primary/80 transition-colors border border-primary/30 px-4 py-2"
                      onClick={startNewConversation}
                    >
                      START NEW CONVERSATION →
                    </button>
                  ) : (
                    <p className="text-xs font-mono text-base-content/30">
                      No credits left —{" "}
                      <a href="/buy" className="underline hover:text-primary">
                        buy more
                      </a>
                    </p>
                  )}
                </div>
              </div>
            )}

            {proofStatus && (
              <div className="flex justify-start">
                <div className="border border-[#222] bg-[#111] px-4 py-3 flex items-center gap-3">
                  <span className="loading loading-spinner loading-xs text-primary"></span>
                  <span className="text-xs font-mono text-base-content/40">{proofStatus}</span>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>
        </div>

        {/* Error */}
        {error && (
          <div className="border-t border-error/20 bg-error/5 px-6 py-3 flex items-center justify-between flex-shrink-0">
            <span className="text-xs font-mono text-error">{error}</span>
            <button
              className="cursor-pointer text-xs font-mono text-base-content/30 hover:text-base-content transition-colors"
              onClick={() => setError(null)}
            >
              DISMISS
            </button>
          </div>
        )}

        {/* Input */}
        <div className="border-t border-[#1f1f1f] px-6 py-4 flex-shrink-0">
          <div className="max-w-3xl mx-auto mb-2 flex items-center justify-between">
            <span className="font-mono text-xs text-base-content/30">
              {conversationEnded ? (
                <span className="text-yellow-500/70">
                  conversation ended —{" "}
                  {availableCredits.length > 0 ? (
                    <button className="cursor-pointer underline hover:text-yellow-500" onClick={startNewConversation}>
                      start new
                    </button>
                  ) : (
                    <a href="/buy" className="underline hover:text-yellow-500">
                      buy credits
                    </a>
                  )}
                </span>
              ) : !hasActiveConversation && availableCredits.length === 0 ? (
                <span className="text-[#F14E47]/70">
                  no credits —{" "}
                  <a href="/buy" className="underline hover:text-[#F14E47]">
                    buy some
                  </a>
                </span>
              ) : hasActiveConversation ? (
                <span>💰 ${tokenBalance.toFixed(4)} remaining · no proof needed</span>
              ) : (
                <span>
                  {availableCredits.length} credit
                  {availableCredits.length !== 1 ? "s" : ""} left · first message generates ZK proof
                </span>
              )}
            </span>
          </div>
          <div className="max-w-3xl mx-auto flex gap-3">
            <textarea
              className="flex-1 bg-[#111] border border-[#333] text-base-content font-mono text-sm px-4 py-3 focus:outline-none focus:border-primary/40 transition-colors resize-none min-h-[48px] max-h-[140px]"
              placeholder={
                conversationEnded
                  ? availableCredits.length > 0
                    ? "Start a new conversation..."
                    : "No credits — go to /buy"
                  : !hasActiveConversation && availableCredits.length === 0
                    ? "No credits — go to /buy to get some"
                    : hasActiveConversation
                      ? "Continue the conversation... (Enter to send)"
                      : "Type your message... (Enter to send, starts a conversation)"
              }
              value={message}
              onChange={e => {
                setMessage(e.target.value);
                setError(null);
              }}
              onKeyDown={e => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (conversationEnded && availableCredits.length > 0) {
                    startNewConversation();
                  }
                  handleSend();
                }
              }}
              disabled={isSending || (!hasActiveConversation && availableCredits.length === 0 && !conversationEnded)}
              rows={1}
            />
            <button
              className="cursor-pointer font-mono text-sm bg-primary text-black font-bold px-5 py-3 hover:bg-primary/80 transition-colors disabled:opacity-30 disabled:cursor-not-allowed self-end flex items-center gap-2"
              disabled={
                isSending ||
                !message.trim() ||
                (!hasActiveConversation && availableCredits.length === 0 && !conversationEnded)
              }
              onClick={() => {
                if (conversationEnded && availableCredits.length > 0) {
                  startNewConversation();
                }
                handleSend();
              }}
            >
              {isSending ? (
                <span className="loading loading-spinner loading-xs"></span>
              ) : hasActiveConversation ? (
                "SEND →"
              ) : (
                "SEND →"
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ChatPage;
