import { getAgentMeridianBase, getAgentMeridianHeaders } from "./agent-meridian.js";
import { log } from "../logger.js";
import { config } from "../config.js";

let _cache = null;
let _cacheAt = 0;
const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch active Discord signal pools from HiveMind API.
 * Returns array of { poolAddress, tokenSymbol, confidence, timestamp }.
 * Never throws — returns [] on any error.
 */
export async function getDiscordSignals() {
  if (!config.screening.useDiscordSignals) return [];
  if (_cache && Date.now() - _cacheAt < CACHE_TTL_MS) return _cache;
  try {
    const res = await fetch(`${getAgentMeridianBase()}/signals/discord/candidates`, {
      headers: getAgentMeridianHeaders(),
    });
    if (!res.ok) throw new Error(`discord signals ${res.status}`);
    const data = await res.json();
    const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
    _cache = candidates
      .map((c) => ({
        poolAddress: c.discovery_pool?.pool_address || c.pool_address || null,
        tokenSymbol: c.discovery_pool?.name || c.token_symbol || null,
        confidence: c.confidence ?? null,
        timestamp: c.first_seen_at || c.timestamp || null,
      }))
      .filter((c) => c.poolAddress);
    _cacheAt = Date.now();
    console.log(`[DISCORD_SIGNAL] Fetched ${_cache.length} active signal(s)`);
    return _cache;
  } catch (err) {
    log("discord_signals_warn", `getDiscordSignals failed: ${err.message}`);
    console.log(`[DISCORD_SIGNAL] Fetch failed: ${err.message}`);
    return [];
  }
}

/**
 * Returns true if poolAddress is in the current Discord signal list.
 */
export async function isDiscordSignal(poolAddress) {
  if (!poolAddress || !config.screening.useDiscordSignals) return false;
  const signals = await getDiscordSignals();
  return signals.some((s) => s.poolAddress === poolAddress);
}

/** Invalidate cache (call after a manual signal refresh). */
export function invalidateDiscordSignalCache() {
  _cache = null;
  _cacheAt = 0;
}
