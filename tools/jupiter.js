import { log } from "../logger.js";

const JUPITER_PRICE_V3 = "https://api.jup.ag/price/v3";
const JUPITER_QUOTE_V6 = "https://quote-api.jup.ag/v6/quote";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Startup connectivity check — fire-and-forget, never throws
(async () => {
  try {
    const result = await getJupiterPrice(WSOL_MINT);
    if (result?.price != null) {
      log("jupiter", `[JUPITER_INIT] connected ✓ SOL=$${result.price.toFixed(2)}`);
    } else {
      log("jupiter_warn", "[JUPITER_INIT] failed — no price returned");
    }
  } catch (err) {
    log("jupiter_warn", `[JUPITER_INIT] failed — ${err.message}`);
  }
})();

function getJupiterKey() {
  return process.env.JUPITER_API_KEY || null;
}

function jupiterHeaders() {
  const key = getJupiterKey();
  // Jupiter Price API V3 uses x-api-key (not Authorization: Bearer)
  return key ? { "x-api-key": key } : {};
}

/**
 * Fetch the current price of a token from Jupiter Price API V3.
 * Returns { price, mint } or null on failure.
 * V3 response: { "<mint>": { usdPrice: number, blockId, decimals, priceChange24h } }
 */
export async function getJupiterPrice(mintAddress) {
  if (!mintAddress) return null;
  try {
    const url = `${JUPITER_PRICE_V3}?ids=${mintAddress}`;
    const res = await fetch(url, { headers: jupiterHeaders() });
    if (!res.ok) {
      log("jupiter_warn", `[JUPITER_ERROR] getJupiterPrice ${res.status}: ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    const entry = data?.[mintAddress];
    if (!entry || entry.usdPrice == null) return null;
    return { price: parseFloat(entry.usdPrice), mint: mintAddress };
  } catch (err) {
    log("jupiter_warn", `[JUPITER_ERROR] getJupiterPrice: ${err.message}`);
    return null;
  }
}

/**
 * Fetch a swap quote from Jupiter v6 Quote API.
 * Returns the raw quote object or null on failure.
 * amount is in token UI units (will be converted to lamports using decimals param).
 */
export async function getSwapQuote({ inputMint, outputMint, amount, decimals = 9 }) {
  if (!inputMint || !outputMint || !amount) return null;
  try {
    const amountRaw = Math.floor(amount * Math.pow(10, decimals));
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(amountRaw),
      slippageBps: "50",
    });
    const url = `${JUPITER_QUOTE_V6}?${params.toString()}`;
    const res = await fetch(url, { headers: jupiterHeaders() });
    if (!res.ok) {
      log("jupiter_warn", `[JUPITER_ERROR] getSwapQuote ${res.status}: ${res.statusText}`);
      return null;
    }
    return await res.json();
  } catch (err) {
    log("jupiter_warn", `[JUPITER_ERROR] getSwapQuote: ${err.message}`);
    return null;
  }
}
