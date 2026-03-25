import { createPublicClient, createWalletClient, http, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";
import { Barretenberg, Fr } from "@aztec/bb.js";
import {
  CONTRACTS, ROUTER_ABI, PRICING_ABI,
  getPrivateKey, getRpcUrl,
} from "./config.js";
import { loadCredits, saveCredits, type Credit } from "./credits.js";

function randomField(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return BigInt("0x" + Buffer.from(bytes).toString("hex"));
}

export async function buyCredits(count = 1): Promise<Credit[]> {
  const account = privateKeyToAccount(getPrivateKey());
  const transport = http(getRpcUrl());
  const publicClient = createPublicClient({ chain: base, transport });
  const walletClient = createWalletClient({ chain: base, transport, account });

  console.log(`[buy] wallet: ${account.address}`);

  // Generate nullifier + secret + commitment for each credit
  const bb = await Barretenberg.new({ threads: 1 });
  const newCredits: Credit[] = [];

  console.log(`[buy] computing ${count} commitment(s)...`);
  for (let i = 0; i < count; i++) {
    const nullifier = randomField();
    const secret = randomField();
    const commitmentFr = await bb.poseidon2Hash([new Fr(nullifier), new Fr(secret)]);
    const commitment = BigInt("0x" + Buffer.from(commitmentFr.value).toString("hex"));
    newCredits.push({
      nullifier: nullifier.toString(),
      secret: secret.toString(),
      commitment: commitment.toString(),
      spent: false,
    });
  }
  await bb.destroy();

  // Get oracle pricing for ETH calculation
  console.log("[buy] fetching oracle price...");
  const oracleData = await publicClient.readContract({
    address: CONTRACTS.CLAWDPricing,
    abi: PRICING_ABI,
    functionName: "getOracleData",
  });

  const [clawdPerEth, , pricePerCreditCLAWD] = oracleData;
  const ethNeeded = (pricePerCreditCLAWD * BigInt(count) * 125n * 10n ** 18n) / (clawdPerEth * 100n);
  console.log(`[buy] ETH needed (25% buffer): ${formatEther(ethNeeded)} ETH`);

  // Broadcast buy tx
  const commitmentArgs = newCredits.map(c => BigInt(c.commitment));
  console.log(`[buy] sending buyWithETH (${count} commitment(s))...`);
  const hash = await walletClient.writeContract({
    address: CONTRACTS.CLAWDRouter,
    abi: ROUTER_ABI,
    functionName: "buyWithETH",
    args: [commitmentArgs, 1n],
    value: ethNeeded,
  });
  console.log(`[buy] tx pending: ${hash}`);

  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  console.log(`[buy] tx confirmed in block ${receipt.blockNumber}`);

  // Persist to credits.json
  const allCredits = loadCredits();
  allCredits.push(...newCredits);
  saveCredits(allCredits);
  console.log(`[buy] saved ${count} credit(s) to credits.json`);

  return newCredits;
}
