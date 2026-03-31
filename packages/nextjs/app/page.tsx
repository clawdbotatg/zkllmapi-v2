"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { NextPage } from "next";
import { formatEther } from "viem";
import { useReadContract } from "wagmi";
import externalContracts from "~~/contracts/externalContracts";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://backend.zkllmapi.com";

const Home: NextPage = () => {
  const [spentCount, setSpentCount] = useState<number | null>(null);
  const [treeSize, setTreeSize] = useState<number | null>(null);
  const [apiCreditsAddress, setApiCreditsAddress] = useState<`0x${string}` | undefined>(undefined);

  const { data: quoteData } = useReadContract({
    address: externalContracts[8453].CLAWDRouter.address,
    abi: externalContracts[8453].CLAWDRouter.abi,
    functionName: "quoteCredits",
    args: [1n],
    chainId: 8453,
  });

  useEffect(() => {
    fetch(`${API_URL}/health`)
      .then(r => r.json())
      .then(d => {
        setSpentCount(d.spentNullifiers ?? null);
        setTreeSize(d.treeSize ?? null);
      })
      .catch(() => {});

    fetch(`${API_URL}/contract`)
      .then(r => r.json())
      .then(d => {
        if (d?.address) setApiCreditsAddress(d.address as `0x${string}`);
      })
      .catch(() => {});
  }, []);

  const priceUsd = quoteData ? `$${Number(formatEther((quoteData as [bigint, bigint])[1])).toFixed(4)}` : null;

  return (
    <div
      className="relative min-h-[calc(100vh-56px)]"
      style={{
        backgroundImage: "url(/hero.jpg)",
        backgroundSize: "cover",
        backgroundPosition: "center top",
      }}
    >
      <div className="absolute inset-0 bg-black/75" />
      <div className="relative z-10">
        <div className="max-w-5xl mx-auto px-6 pt-24 pb-32">
          {/* Tag line */}
          <div className="mb-6">
            <span className="text-xs font-mono text-primary border border-primary/30 px-2 py-1">
              PRIVATE LLM API — BASE MAINNET — OPEN SOURCE
            </span>
          </div>

          {/* Hero */}
          <h1 className="text-6xl md:text-7xl font-mono font-bold leading-none mb-8 tracking-tight">
            Anonymous LLM
            <br />
            access. No account.
            <br />
            No identity.
            <br />
            <span className="text-4xl md:text-5xl text-base-content/50">Hella forkable.</span>
          </h1>

          <p className="text-base-content/50 text-lg font-mono mb-12 max-w-xl leading-relaxed">
            Buy a credit onchain. Your browser generates a<br />
            zero-knowledge proof. The server verifies it.
            <br />
            It knows you paid. Nothing else.
          </p>

          {/* CTAs */}
          <div className="flex flex-wrap items-center gap-4 mb-20">
            <Link
              href="/buy"
              className="font-mono text-sm bg-[#F14E47] text-black px-6 py-3 hover:bg-[#d43d37] transition-colors font-bold"
            >
              BUY A CREDIT →
            </Link>
            <a
              href="/skill.md"
              className="font-mono text-sm border border-[#333] text-base-content/60 px-6 py-3 hover:border-[#42F38F]/50 hover:text-[#42F38F] transition-colors"
            >
              TRAIN YOUR BOT ↗
            </a>
          </div>

          {/* Stats bar */}
          <div className="border border-[#333] grid grid-cols-3 mb-20 bg-black/80 backdrop-blur-sm">
            <div className="border-r border-[#333] p-6">
              <p className="text-3xl font-mono font-bold">{treeSize ?? "—"}</p>
              <p className="text-xs font-mono text-base-content/40 mt-1">CREDITS ISSUED</p>
            </div>
            <div className="border-r border-[#333] p-6">
              <p className="text-3xl font-mono font-bold">{spentCount ?? "—"}</p>
              <p className="text-xs font-mono text-base-content/40 mt-1">CHAT SESSIONS STARTED</p>
            </div>
            <div className="p-6">
              <p className="text-3xl font-mono font-bold text-[#42F38F]">{priceUsd ?? "—"}</p>
              <p className="text-xs font-mono text-base-content/40 mt-1">PER CREDIT</p>
            </div>
          </div>

          {/* How it works */}
          <div className="mb-20">
            <p className="text-xs font-mono text-base-content/30 mb-8 tracking-widest">HOW IT WORKS</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-0 border border-[#333] bg-black/80 backdrop-blur-sm">
              {[
                {
                  n: "01",
                  title: "Buy a credit",
                  body: priceUsd
                    ? `Pay ${priceUsd} on Base. Your browser generates a secret locally — the contract stores only a cryptographic hash.`
                    : "Pay on Base. Your browser generates a secret locally — the contract stores only a cryptographic hash.",
                },
                {
                  n: "02",
                  title: "Generate a proof",
                  body: "When you make a request, your browser generates a zero-knowledge proof that you own a valid credit — without revealing which one.",
                },
                {
                  n: "03",
                  title: "Start a chat session",
                  body: "POST your proof to start a chat session. You get a bearer token with a $0.05 balance — keep chatting until it runs out.",
                },
              ].map(({ n, title, body }, i) => (
                <div key={n} className={`p-8 ${i < 2 ? "md:border-r border-b md:border-b-0 border-[#333]" : ""}`}>
                  <p className="text-xs font-mono text-[#42F38F] mb-4">{n}</p>
                  <h3 className="font-mono font-bold text-base mb-3">{title}</h3>
                  <p className="text-sm font-mono text-base-content/50 leading-relaxed">{body}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Code snippet */}
          <div className="mb-20">
            <p className="text-xs font-mono text-base-content/30 mb-4 tracking-widest">
              LOCAL PROXY (OpenAI-COMPATIBLE)
            </p>
            <div className="border border-[#333] bg-black/90 backdrop-blur-sm overflow-x-auto">
              <div className="border-b border-[#333] px-4 py-2 flex items-center gap-2">
                <div className="w-2 h-2 rounded-full bg-[#333]"></div>
                <div className="w-2 h-2 rounded-full bg-[#333]"></div>
                <div className="w-2 h-2 rounded-full bg-[#333]"></div>
                <span className="text-xs font-mono text-base-content/30 ml-2">terminal</span>
              </div>
              <pre className="p-6 text-xs font-mono text-base-content/70 leading-relaxed overflow-x-auto">{`# Run the OpenAI-compatible proxy locally.
# It auto-buys credits, generates ZK proofs client-side, and manages sessions.
git clone https://github.com/clawdbotatg/zkllmapi-v2
cd zkllmapi-v2 && yarn install && yarn proxy:dev

# Point any OpenAI client at the proxy:
curl -X POST http://localhost:3100/v1/chat/completions \\
  -H 'Content-Type: application/json' \\
  -d '{
    "model": "zai-org-glm-5",
    "messages": [{"role": "user", "content": "Hello"}]
  }'

# Works with any OpenAI-compatible SDK — just set the base URL:
# openai.base_url = "http://localhost:3100/v1"

# 1 credit = 1 chat session. ZK proof is generated locally —
# the server verifies it but never learns your identity.`}</pre>
            </div>
          </div>

          {/* Bottom links */}
          <div className="flex flex-wrap gap-8 text-xs font-mono text-base-content/50 bg-black/60 backdrop-blur-sm px-4 py-3 border border-[#333]">
            <a
              href="https://github.com/clawdbotatg/zkllmapi-v2/tree/main/packages/nextjs"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#42F38F] transition-colors"
            >
              FRONTEND GITHUB ↗
            </a>
            <a
              href="https://github.com/clawdbotatg/zkllmapi-v2/tree/main/packages/backend"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#42F38F] transition-colors"
            >
              BACKEND GITHUB ↗
            </a>
            <a
              href="https://github.com/clawdbotatg/zkllmapi-v2/tree/main/packages/proxy"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#42F38F] transition-colors"
            >
              PROXY GITHUB ↗
            </a>
            <a
              href="https://github.com/clawdbotatg/zkllmapi-v2"
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#42F38F] transition-colors"
            >
              MONOREPO ↗
            </a>
            <a
              href={apiCreditsAddress ? `https://basescan.org/address/${apiCreditsAddress}` : "#"}
              target="_blank"
              rel="noopener noreferrer"
              className="hover:text-[#42F38F] transition-colors"
            >
              CONTRACT ↗
            </a>
            <Link href="/about" className="hover:text-[#42F38F] transition-colors">
              HOW IT WORKS
            </Link>
            <Link href="/fork" className="hover:text-[#42F38F] transition-colors">
              FORK THIS
            </Link>
            <a href="/skill.md" className="hover:text-[#42F38F] transition-colors">
              SKILL.md
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Home;
