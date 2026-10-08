// deno run scripts/smoke/deno.mjs   (no permissions needed)
import { smoke } from "./runtime.mjs";

await smoke();
console.log("deno smoke: ok");
