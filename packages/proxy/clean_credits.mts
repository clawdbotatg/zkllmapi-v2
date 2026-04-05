import { loadCredits, saveCredits } from "./src/credits.js";
const all = loadCredits();
const unspent = all.filter(c => !c.spent);
if (unspent.length > 0) {
  const latest = unspent[unspent.length - 1];
  console.log("keeping only latest credit:", latest.commitment.slice(0,30));
  saveCredits([latest]);
} else {
  console.log("no unspent credits");
}
