"use client";

import { useEffect, useState } from "react";
import type { NextPage } from "next";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "https://backend.v2.zkllmapi.com";

interface HealthData {
  status: string;
  spentNullifiers: number;
  currentRoot: string;
  validRoots: number;
  treeSize: number;
}

interface ContractData {
  address: string;
  chainId: number;
}

const DebugPage: NextPage = () => {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [contract, setContract] = useState<ContractData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([fetch(`${API_URL}/health`).then(r => r.json()), fetch(`${API_URL}/contract`).then(r => r.json())])
      .then(([h, c]) => {
        setHealth(h);
        setContract(c);
        setLoading(false);
      })
      .catch(e => {
        setError(e.message);
        setLoading(false);
      });
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-56px)]">
        <span className="font-mono text-sm opacity-50">loading...</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[calc(100vh-56px)]">
        <div className="border border-error p-6 rounded-lg">
          <p className="font-mono text-error">Error: {error}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-6 py-20">
      <h1 className="text-4xl font-mono font-bold mb-8">Debug</h1>

      <div className="space-y-6">
        {/* Backend Health */}
        <div className="border border-base-content/20 rounded-lg p-6">
          <h2 className="font-mono text-xs tracking-widest uppercase opacity-50 mb-4">Backend Health</h2>
          <div className="space-y-2 font-mono text-sm">
            <p>
              <span className="opacity-50">status:</span>{" "}
              <span className={health?.status === "ok" ? "text-success" : "text-error"}>{health?.status}</span>
            </p>
            <p>
              <span className="opacity-50">spent nullifiers:</span> {health?.spentNullifiers}
            </p>
            <p>
              <span className="opacity-50">tree size:</span> {health?.treeSize}
            </p>
            <p>
              <span className="opacity-50">valid roots:</span> {health?.validRoots}
            </p>
            <p>
              <span className="opacity-50">current root:</span>{" "}
              <span className="text-xs break-all">{health?.currentRoot}</span>
            </p>
          </div>
        </div>

        {/* Contract */}
        <div className="border border-base-content/20 rounded-lg p-6">
          <h2 className="font-mono text-xs tracking-widest uppercase opacity-50 mb-4">Contract</h2>
          <div className="space-y-2 font-mono text-sm">
            <p>
              <span className="opacity-50">address:</span>{" "}
              <a
                href={`https://basescan.org/address/${contract?.address}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[#42F38F] hover:underline text-xs break-all"
              >
                {contract?.address}
              </a>
            </p>
            <p>
              <span className="opacity-50">chain:</span> Base (chainId {contract?.chainId})
            </p>
          </div>
        </div>

        {/* API Endpoints */}
        <div className="border border-base-content/20 rounded-lg p-6">
          <h2 className="font-mono text-xs tracking-widest uppercase opacity-50 mb-4">API Endpoints</h2>
          <div className="space-y-2 font-mono text-sm">
            {[
              ["GET", "/health", "Server health + stats"],
              ["GET", "/contract", "Contract address + chainId"],
              ["GET", "/tree", "Full Merkle tree"],
              ["GET", "/circuit", "Circuit JSON for client-side proving"],
              ["POST", "/v1/chat/start", "Burn proof, get token + first response"],
              ["POST", "/v1/chat", "Continue conversation with bearer token"],
            ].map(([method, path, desc]) => (
              <div key={path} className="flex items-start gap-3">
                <span
                  className={`shrink-0 px-2 py-0.5 rounded text-xs ${
                    method === "GET" ? "bg-blue-500/20 text-blue-400" : "bg-green-500/20 text-green-400"
                  }`}
                >
                  {method}
                </span>
                <div>
                  <p className="font-mono text-xs">{path}</p>
                  <p className="opacity-50 text-xs">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default DebugPage;
