import { log } from "../logger.js";

const HELIUS_BASE = "https://api.helius.xyz";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

// Startup connectivity check — fire-and-forget, never throws
(async () => {
  const key = process.env.HELIUS_API_KEY;
  if (!key) {
    log("helius", "[HELIUS_INIT] no API key set — skipping check");
    return;
  }
  try {
    const url = `${HELIUS_BASE}/v0/token-metadata?api-key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mintAccounts: [WSOL_MINT] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error("empty response");
    log("helius", "[HELIUS_INIT] connected ✓");
  } catch (err) {
    log("helius_warn", `[HELIUS_INIT] failed — ${err.message}`);
  }
})();

function getHeliusKey() {
  return process.env.HELIUS_API_KEY || null;
}

/**
 * Fetch enhanced transaction details from Helius.
 * Returns null if HELIUS_API_KEY is not set or the call fails.
 */
export async function getEnhancedTransaction(signature) {
  const key = getHeliusKey();
  if (!key || !signature) return null;
  try {
    const url = `${HELIUS_BASE}/v0/transactions?api-key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transactions: [signature] }),
    });
    if (!res.ok) {
      log("helius_warn", `[HELIUS_ERROR] getEnhancedTransaction ${res.status}: ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (err) {
    log("helius_warn", `[HELIUS_ERROR] getEnhancedTransaction: ${err.message}`);
    return null;
  }
}

/**
 * Fetch token metadata from Helius DAS API.
 * Returns null if HELIUS_API_KEY is not set or the call fails.
 */
export async function getTokenMetadata(mintAddress) {
  const key = getHeliusKey();
  if (!key || !mintAddress) return null;
  try {
    const url = `${HELIUS_BASE}/v0/token-metadata?api-key=${key}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mintAccounts: [mintAddress] }),
    });
    if (!res.ok) {
      log("helius_warn", `[HELIUS_ERROR] getTokenMetadata ${res.status}: ${res.statusText}`);
      return null;
    }
    const data = await res.json();
    return Array.isArray(data) && data.length > 0 ? data[0] : null;
  } catch (err) {
    log("helius_warn", `[HELIUS_ERROR] getTokenMetadata: ${err.message}`);
    return null;
  }
}
