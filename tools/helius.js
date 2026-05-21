import { log } from "../logger.js";

const HELIUS_BASE = "https://api.helius.xyz";

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
