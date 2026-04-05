import "dotenv/config";
import { buyCredits } from "./src/buy.js";

console.log("Buying 1 credit...");
const credits = await buyCredits(1);
console.log("bought:", JSON.stringify(credits, null, 2));
