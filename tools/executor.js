import { discoverPools, getPoolDetail, getTopCandidates } from "./screening.js";
import { checkPriceVelocity, checkBtcTrend, getPriceInfo } from "./okx.js";
import {
  getActiveBin,
  deployPosition,
  getMyPositions,
  getWalletPositions,
  getPositionPnl,
  claimFees,
  closePosition,
  searchPools,
} from "./dlmm.js";
import { getWalletBalances, swapToken } from "./wallet.js";
import { studyTopLPers } from "./study.js";
import { addLesson, clearAllLessons, clearPerformance, removeLessonsByKeyword, getPerformanceHistory, pinLesson, unpinLesson, listLessons } from "../lessons.js";
import { setPositionInstruction, recordClosedToken, isTokenOnCooldown, setPositionHighConvictionFlags, getStrategyMode, getTrackedPosition, markDiscordSignalPosition } from "../state.js";
import { isDiscordSignal } from "./discord-signals.js";
import { calculateSupertrend, calculateFibLevels, selectBinsBySupertrendPosition, fetch15mCandles } from "./indicators.js";

import { getPoolMemory, addPoolNote } from "../pool-memory.js";
import { addStrategy, listStrategies, getStrategy, setActiveStrategy, removeStrategy } from "../strategy-library.js";
import { addToBlacklist, removeFromBlacklist, listBlacklist } from "../token-blacklist.js";
import { blockDev, unblockDev, listBlockedDevs } from "../dev-blocklist.js";
import { addSmartWallet, removeSmartWallet, listSmartWallets, checkSmartWalletsOnPool } from "../smart-wallets.js";
import { getTokenInfo, getTokenHolders, getTokenNarrative } from "./token.js";
import { getJupiterPrice, getSwapQuote } from "./jupiter.js";
import { config, reloadScreeningThresholds, MIN_SAFE_BINS_BELOW } from "../config.js";
import { getRecentDecisions } from "../decision-log.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execSync, spawn } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "../user-config.json");
const POOL_DISCOVERY_BASE = "https://pool-discovery-api.datapi.meteora.ag";
const MIN_VOLATILITY_TIMEFRAME = "30m";
const TIMEFRAME_MINUTES = {
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "12h": 720,
  "24h": 1440,
};
import { log, logAction } from "../logger.js";
import { notifyDeploy, notifyClose, notifySwap, notifyHighConviction, notifyDumpCatchEntry, notifyDumpCatchExit, notifyDumpCatchSL } from "../telegram.js";

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getVolatilityTimeframe(sourceTimeframe) {
  const source = String(sourceTimeframe || "").trim();
  const sourceMinutes = TIMEFRAME_MINUTES[source];
  const minMinutes = TIMEFRAME_MINUTES[MIN_VOLATILITY_TIMEFRAME];
  return sourceMinutes != null && sourceMinutes >= minMinutes ? source : MIN_VOLATILITY_TIMEFRAME;
}

function poolDetailTvl(pool) {
  return numberOrNull(pool?.tvl ?? pool?.active_tvl ?? pool?.liquidity);
}

function poolDetailBinStep(pool) {
  return numberOrNull(pool?.dlmm_params?.bin_step ?? pool?.pool_config?.bin_step);
}

function poolDetailFeeActiveTvlRatio(pool) {
  return numberOrNull(pool?.fee_active_tvl_ratio);
}

function poolDetailVolatility(pool) {
  return numberOrNull(pool?.volatility);
}

function poolDetailTokenCreatedAt(pool) {
  const ts = pool?.token_x?.created_at;
  if (!ts) return null;
  return Math.floor((Date.now() - Number(ts)) / 3_600_000); // hours old
}

async function fetchFreshPoolDetail(poolAddress, timeframe = config.screening.timeframe || "5m") {
  const encodedTimeframe = encodeURIComponent(timeframe);
  const filter = encodeURIComponent(`pool_address=${poolAddress}`);
  const url = `${POOL_DISCOVERY_BASE}/pools?page_size=1&filter_by=${filter}&timeframe=${encodedTimeframe}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Pool Discovery API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  return (data?.data || [])[0] ?? null;
}

async function validateDeployPoolThresholds(args) {
  let detail;
  try {
    detail = await fetchFreshPoolDetail(args.pool_address);
    if (!detail) throw new Error(`Pool ${args.pool_address} not found`);
  } catch (error) {
    return {
      pass: false,
      reason: `Could not verify pool screening thresholds before deploy: ${error.message}`,
    };
  }

  // Discord signal fast-track: relaxed entry thresholds for high-risk/high-reward Discord pools
  const discordFastTrack = config.screening.useDiscordSignals && await isDiscordSignal(args.pool_address);
  if (discordFastTrack) {
    const symbol = args.pool_name || args.pool_address?.slice(0, 8);
    console.log(`[DISCORD_SIGNAL] Fast-track lane active for ${symbol} — relaxed entry rules applied (age≥6h, feeRatio≥0.01, botMax40%, holders≥100)`);
    log("safety", `[DISCORD_SIGNAL] Fast-track: ${symbol}`);
  }

  const tvl = poolDetailTvl(detail);
  const minTvl = numberOrNull(config.screening.minTvl);
  const maxTvl = numberOrNull(config.screening.maxTvl);
  if (tvl == null) {
    return {
      pass: false,
      reason: "Could not verify pool TVL before deploy.",
    };
  }
  if (minTvl != null && minTvl > 0 && tvl < minTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is below configured minTvl $${minTvl}.`,
    };
  }
  if (maxTvl != null && maxTvl > 0 && tvl > maxTvl) {
    return {
      pass: false,
      reason: `Pool TVL $${tvl} is above configured maxTvl $${maxTvl}.`,
    };
  }

  const feeActiveTvlRatio = poolDetailFeeActiveTvlRatio(detail);
  const minFeeActiveTvlRatio = discordFastTrack ? 0.01 : numberOrNull(config.screening.minFeeActiveTvlRatio);
  if (
    minFeeActiveTvlRatio != null &&
    minFeeActiveTvlRatio > 0 &&
    (feeActiveTvlRatio == null || feeActiveTvlRatio < minFeeActiveTvlRatio)
  ) {
    if (discordFastTrack) console.log(`[DISCORD_SIGNAL] feeActiveTvlRatio ${feeActiveTvlRatio ?? "unknown"}% failed even relaxed 0.01% threshold`);
    return {
      pass: false,
      reason: `Pool fee/active-TVL ${feeActiveTvlRatio ?? "unknown"}% is below ${discordFastTrack ? "Discord fast-track minimum 0.01" : `configured minFeeActiveTvlRatio ${minFeeActiveTvlRatio}`}%.`,
    };
  }

  // Pool/token age check
  // Discord fast-track: minimum 6h, HC override tiers skipped entirely
  // Normal: minimum 72h, with two-tier HC Override for 24-72h pools
  const tokenAgeHours = poolDetailTokenCreatedAt(detail);

  if (discordFastTrack) {
    if (tokenAgeHours != null && tokenAgeHours < 6) {
      const reason = `[DISCORD_SIGNAL] Pool age block: ${args.pool_address} is only ${tokenAgeHours.toFixed(1)}h old (Discord fast-track minimum 6h)`;
      console.log(reason);
      return { pass: false, reason };
    }
    // ≥ 6h passes — fall through to volatility/binStep checks
  } else {
    // Normal path: 72h minimum with two-tier HC Override for 24-72h
    //   < 24h      → always blocked, no exceptions
    //   24–48h     → Tier 1 HC Override (organic ≥ 80%, score ≥ 4.3)
    //   48–72h     → Tier 2 HC Override (organic ≥ 75%, score ≥ 4.0)
    //   ≥ 72h      → normal deploy
    const MIN_POOL_AGE_HOURS = 72;
    if (tokenAgeHours != null && tokenAgeHours < MIN_POOL_AGE_HOURS) {
      const organicScore = numberOrNull(detail?.organic_score ?? args.organic_score);
      const feeTvlRatio  = numberOrNull(feeActiveTvlRatio ?? args.fee_tvl_ratio);
      const score        = numberOrNull(args.score);
      const amountSol    = numberOrNull(args.amount_y ?? args.amount_sol ?? 0);

      if (tokenAgeHours < 24) {
        return {
          pass: false,
          reason: `[SAFETY] Pool age block: ${args.pool_address} is only ${tokenAgeHours.toFixed(1)}h old (minimum 24h — no exceptions)`,
        };
      }

      const isTier1 = tokenAgeHours < 48;
      const minOrganic = isTier1 ? 80 : 75;
      const minScore   = isTier1 ? 4.3 : 4.0;
      const tierLabel  = isTier1 ? "Tier 1" : "Tier 2";
      const tierWindow = isTier1 ? "24-48h" : "48-72h";

      const organicOk = organicScore != null && organicScore >= minOrganic;
      const scoreOk   = score        != null && score         >= minScore;

      if (organicOk && scoreOk) {
        log("safety", `[SAFETY] ⚡ ${tierLabel} HC Override: ${tokenAgeHours.toFixed(1)}h pool — organic ${organicScore}%, score ${score}`);
        const hcTier = isTier1 ? 1 : 2;
        return { pass: true, highConviction: true, hcTier, tierWindow, tokenAgeHours, organicScore, feeTvlRatio, feeActiveTvlRatio, score, amountSol };
      }

      const failReasons = [
        !organicOk && `organic ${organicScore ?? "unknown"}% < ${minOrganic}%`,
        !scoreOk   && `score ${score ?? "not provided"} < ${minScore}`,
      ].filter(Boolean).join(", ");

      return {
        pass: false,
        reason: `[SAFETY] Pool age block: ${args.pool_address} is ${tokenAgeHours.toFixed(1)}h old. ${tierLabel} HC Override failed: ${failReasons}`,
      };
    }
  }

  const volatilityTimeframe = getVolatilityTimeframe(config.screening.timeframe || "5m");
  let volatilityDetail = detail;
  if ((config.screening.timeframe || "5m") !== volatilityTimeframe) {
    try {
      volatilityDetail = await fetchFreshPoolDetail(args.pool_address, volatilityTimeframe);
    } catch (error) {
      return {
        pass: false,
        reason: `Could not verify pool ${volatilityTimeframe} volatility before deploy: ${error.message}`,
      };
    }
  }

  const volatility = poolDetailVolatility(volatilityDetail);
  if (volatility == null || volatility <= 0) {
    console.log(`[VOLATILITY_SKIP] 30m volatility unavailable (value=${volatility ?? "null"}) — using 5m data only, soft pass`);
    log("safety", `[VOLATILITY_SKIP] 30m volatility unavailable — soft pass, continuing with 5m data`);
  }

  const actualBinStep = poolDetailBinStep(detail);
  const minStep = numberOrNull(config.screening.minBinStep);
  const maxStep = numberOrNull(config.screening.maxBinStep);
  if (actualBinStep != null && minStep != null && actualBinStep < minStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is below configured minBinStep ${minStep}.`,
    };
  }
  if (actualBinStep != null && maxStep != null && actualBinStep > maxStep) {
    return {
      pass: false,
      reason: `Pool bin_step ${actualBinStep} is above configured maxBinStep ${maxStep}.`,
    };
  }

  return { pass: true, feeActiveTvlRatio, discordFastTrack };
}

// Registered by index.js so update_config can restart cron jobs when intervals change
let _cronRestarter = null;
export function registerCronRestarter(fn) { _cronRestarter = fn; }

// Last deploy meta — populated by runSafetyChecks on successful deploy safety pass.
// Used by index.js to enrich the screening cycle Telegram report.
let _lastDeployMeta = null;
export function getLastDeployMeta() {
  const meta = _lastDeployMeta;
  _lastDeployMeta = null; // consume once
  return meta;
}

function coerceBoolean(value, key) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  throw new Error(`${key} must be true or false`);
}

function coerceFiniteNumber(value, key) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a finite number`);
  return n;
}

function coerceString(value, key) {
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value.trim();
}

function coerceStringArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`${key} must be an array of strings`);
  return value.map((entry) => coerceString(entry, key)).filter(Boolean);
}

function normalizeConfigValue(key, value) {
  const booleanKeys = new Set([
    "excludeHighSupplyConcentration",
    "useDiscordSignals",
    "avoidPvpSymbols",
    "blockPvpSymbols",
    "autoSwapAfterClaim",
    "trailingTakeProfit",
    "solMode",
    "darwinEnabled",
    "lpAgentRelayEnabled",
  ]);
  const arrayKeys = new Set(["allowedLaunchpads", "blockedLaunchpads"]);
  const stringKeys = new Set([
    "timeframe",
    "category",
    "discordSignalMode",
    "strategy",
    "managementModel",
    "screeningModel",
    "generalModel",
    "hiveMindUrl",
    "hiveMindApiKey",
    "agentId",
    "hiveMindPullMode",
    "publicApiKey",
    "agentMeridianApiUrl",
  ]);
  if (value === null) return null;
  if (booleanKeys.has(key)) return coerceBoolean(value, key);
  if (arrayKeys.has(key)) return coerceStringArray(value, key);
  if (stringKeys.has(key)) return coerceString(value, key);
  return coerceFiniteNumber(value, key);
}

// Map tool names to implementations
const toolMap = {
  discover_pools: discoverPools,
  get_top_candidates: getTopCandidates,
  get_pool_detail: getPoolDetail,
  get_position_pnl: getPositionPnl,
  get_active_bin: getActiveBin,
  deploy_position: deployPosition,
  get_my_positions: getMyPositions,
  get_wallet_positions: getWalletPositions,
  search_pools: searchPools,
  get_token_info: getTokenInfo,
  get_token_holders: getTokenHolders,
  get_token_narrative: getTokenNarrative,
  check_price_velocity: checkPriceVelocity,
  check_btc_trend: checkBtcTrend,
  add_smart_wallet: addSmartWallet,
  remove_smart_wallet: removeSmartWallet,
  list_smart_wallets: listSmartWallets,
  check_smart_wallets_on_pool: checkSmartWalletsOnPool,
  claim_fees: claimFees,
  close_position: closePosition,
  get_wallet_balance: getWalletBalances,
  swap_token: swapToken,
  get_top_lpers: studyTopLPers,
  study_top_lpers: studyTopLPers,
  set_position_note: ({ position_address, instruction }) => {
    const ok = setPositionInstruction(position_address, instruction || null);
    if (!ok) return { error: `Position ${position_address} not found in state` };
    return { saved: true, position: position_address, instruction: instruction || null };
  },
  self_update: async () => {
    try {
      const result = execSync("git pull", { cwd: process.cwd(), encoding: "utf8" }).trim();
      if (result.includes("Already up to date")) {
        return { success: true, updated: false, message: "Already up to date — no restart needed." };
      }
      // Delay restart so this tool response (and Telegram message) gets sent first
      setTimeout(() => {
        if (!process.env.pm_id) {
          const child = spawn(process.execPath, process.argv.slice(1), {
            detached: true,
            stdio: "inherit",
            cwd: process.cwd(),
          });
          child.unref();
        }
        process.exit(0);
      }, 3000);
      const restartMode = process.env.pm_id
        ? "PM2 detected — exiting in 3s so PM2 can restart the managed process."
        : "Restarting in 3s...";
      return { success: true, updated: true, message: `Updated! ${restartMode}\n${result}` };
    } catch (e) {
      return { success: false, error: e.message };
    }
  },
  get_performance_history: getPerformanceHistory,
  get_recent_decisions: ({ limit } = {}) => ({ decisions: getRecentDecisions(limit || 6) }),
  add_strategy:        addStrategy,
  list_strategies:     listStrategies,
  get_strategy:        getStrategy,
  set_active_strategy: setActiveStrategy,
  remove_strategy:     removeStrategy,
  get_pool_memory: getPoolMemory,
  add_pool_note: addPoolNote,
  add_to_blacklist: addToBlacklist,
  remove_from_blacklist: removeFromBlacklist,
  list_blacklist: listBlacklist,
  block_deployer: blockDev,
  unblock_deployer: unblockDev,
  list_blocked_deployers: listBlockedDevs,
  add_lesson: ({ rule, tags, pinned, role }) => {
    addLesson(rule, tags || [], { pinned: !!pinned, role: role || null });
    return { saved: true, rule, pinned: !!pinned, role: role || "all" };
  },
  pin_lesson:   ({ id }) => pinLesson(id),
  unpin_lesson: ({ id }) => unpinLesson(id),
  list_lessons: ({ role, pinned, tag, limit } = {}) => listLessons({ role, pinned, tag, limit }),
  clear_lessons: ({ mode, keyword }) => {
    if (mode === "all") {
      const n = clearAllLessons();
      log("lessons", `Cleared all ${n} lessons`);
      return { cleared: n, mode: "all" };
    }
    if (mode === "performance") {
      const n = clearPerformance();
      log("lessons", `Cleared ${n} performance records`);
      return { cleared: n, mode: "performance" };
    }
    if (mode === "keyword") {
      if (!keyword) return { error: "keyword required for mode=keyword" };
      const n = removeLessonsByKeyword(keyword);
      log("lessons", `Cleared ${n} lessons matching "${keyword}"`);
      return { cleared: n, mode: "keyword", keyword };
    }
    return { error: "invalid mode" };
  },
  update_config: ({ changes, reason = "" }) => {
    // Flat key → config section mapping (covers everything in config.js)
    const CONFIG_MAP = {
      // screening
      minFeeActiveTvlRatio: ["screening", "minFeeActiveTvlRatio"],
      excludeHighSupplyConcentration: ["screening", "excludeHighSupplyConcentration"],
      minTvl: ["screening", "minTvl"],
      maxTvl: ["screening", "maxTvl"],
      minVolume: ["screening", "minVolume"],
      minOrganic: ["screening", "minOrganic"],
      minQuoteOrganic: ["screening", "minQuoteOrganic"],
      minHolders: ["screening", "minHolders"],
      minMcap: ["screening", "minMcap"],
      maxMcap: ["screening", "maxMcap"],
      minBinStep: ["screening", "minBinStep"],
      maxBinStep: ["screening", "maxBinStep"],
      timeframe: ["screening", "timeframe"],
      category: ["screening", "category"],
      minTokenFeesSol: ["screening", "minTokenFeesSol"],
      useDiscordSignals: ["screening", "useDiscordSignals"],
      discordSignalMode: ["screening", "discordSignalMode"],
      avoidPvpSymbols: ["screening", "avoidPvpSymbols"],
      blockPvpSymbols: ["screening", "blockPvpSymbols"],
      maxBundlePct:     ["screening", "maxBundlePct"],
      maxBotHoldersPct: ["screening", "maxBotHoldersPct"],
      maxTop10Pct: ["screening", "maxTop10Pct"],
      allowedLaunchpads: ["screening", "allowedLaunchpads"],
      blockedLaunchpads: ["screening", "blockedLaunchpads"],
      minTokenAgeHours: ["screening", "minTokenAgeHours"],
      maxTokenAgeHours: ["screening", "maxTokenAgeHours"],
      athFilterPct:     ["screening", "athFilterPct"],
      minFeePerTvl24h: ["management", "minFeePerTvl24h"],
      // management
      minClaimAmount: ["management", "minClaimAmount"],
      autoSwapAfterClaim: ["management", "autoSwapAfterClaim"],
      outOfRangeBinsToClose: ["management", "outOfRangeBinsToClose"],
      outOfRangeWaitMinutes: ["management", "outOfRangeWaitMinutes"],
      oorCooldownTriggerCount: ["management", "oorCooldownTriggerCount"],
      oorCooldownHours: ["management", "oorCooldownHours"],
      repeatDeployCooldownEnabled: ["management", "repeatDeployCooldownEnabled"],
      repeatDeployCooldownTriggerCount: ["management", "repeatDeployCooldownTriggerCount"],
      repeatDeployCooldownHours: ["management", "repeatDeployCooldownHours"],
      repeatDeployCooldownScope: ["management", "repeatDeployCooldownScope"],
      repeatDeployCooldownMinFeeEarnedPct: ["management", "repeatDeployCooldownMinFeeEarnedPct"],
      minVolumeToRebalance: ["management", "minVolumeToRebalance"],
      stopLossPct: ["management", "stopLossPct"],
      takeProfitPct: ["management", "takeProfitPct"],
      takeProfitFeePct: ["management", "takeProfitPct"],
      trailingTakeProfit: ["management", "trailingTakeProfit"],
      trailingTriggerPct: ["management", "trailingTriggerPct"],
      trailingDropPct: ["management", "trailingDropPct"],
      pnlSanityMaxDiffPct: ["management", "pnlSanityMaxDiffPct"],
      solMode: ["management", "solMode"],
      minSolToOpen: ["management", "minSolToOpen"],
      deployAmountSol: ["management", "deployAmountSol"],
      gasReserve: ["management", "gasReserve"],
      positionSizePct: ["management", "positionSizePct"],
      minAgeBeforeYieldCheck: ["management", "minAgeBeforeYieldCheck"],
      // risk
      maxPositions: ["risk", "maxPositions"],
      maxDeployAmount: ["risk", "maxDeployAmount"],
      // schedule
      managementIntervalMin: ["schedule", "managementIntervalMin"],
      screeningIntervalMin: ["schedule", "screeningIntervalMin"],
      healthCheckIntervalMin: ["schedule", "healthCheckIntervalMin"],
      // models
      managementModel: ["llm", "managementModel"],
      screeningModel: ["llm", "screeningModel"],
      generalModel: ["llm", "generalModel"],
      temperature: ["llm", "temperature"],
      maxTokens: ["llm", "maxTokens"],
      maxSteps: ["llm", "maxSteps"],
      // strategy
      strategy: ["strategy", "strategy"],
      binsBelow: ["strategy", "maxBinsBelow", ["maxBinsBelow"]],
      minBinsBelow: ["strategy", "minBinsBelow"],
      maxBinsBelow: ["strategy", "maxBinsBelow"],
      defaultBinsBelow: ["strategy", "defaultBinsBelow"],
      // hivemind
      hiveMindUrl: ["hiveMind", "url"],
      hiveMindApiKey: ["hiveMind", "apiKey"],
      agentId: ["hiveMind", "agentId"],
      hiveMindPullMode: ["hiveMind", "pullMode"],
      // meridian api / relay
      publicApiKey: ["api", "publicApiKey"],
      agentMeridianApiUrl: ["api", "url"],
      lpAgentRelayEnabled: ["api", "lpAgentRelayEnabled"],
      // chart indicators
      chartIndicatorsEnabled: ["indicators", "enabled", ["chartIndicators", "enabled"]],
      indicatorEntryPreset: ["indicators", "entryPreset", ["chartIndicators", "entryPreset"]],
      indicatorExitPreset: ["indicators", "exitPreset", ["chartIndicators", "exitPreset"]],
      rsiLength: ["indicators", "rsiLength", ["chartIndicators", "rsiLength"]],
      indicatorIntervals: ["indicators", "intervals", ["chartIndicators", "intervals"]],
      indicatorCandles: ["indicators", "candles", ["chartIndicators", "candles"]],
      rsiOversold: ["indicators", "rsiOversold", ["chartIndicators", "rsiOversold"]],
      rsiOverbought: ["indicators", "rsiOverbought", ["chartIndicators", "rsiOverbought"]],
      requireAllIntervals: ["indicators", "requireAllIntervals", ["chartIndicators", "requireAllIntervals"]],
    };

    const applied = {};
    const unknown = [];

    // Build case-insensitive lookup
    const CONFIG_MAP_LOWER = Object.fromEntries(
      Object.entries(CONFIG_MAP).map(([k, v]) => [k.toLowerCase(), [k, v]])
    );

    if (!changes || typeof changes !== "object" || Array.isArray(changes)) {
      return { success: false, error: "changes must be an object", reason };
    }

    const STRATEGY_BIN_KEYS = new Set(["binsBelow", "minBinsBelow", "maxBinsBelow", "defaultBinsBelow"]);
    for (const [key, val] of Object.entries(changes)) {
      const match = CONFIG_MAP[key] ? [key, CONFIG_MAP[key]] : CONFIG_MAP_LOWER[key.toLowerCase()];
      if (!match) { unknown.push(key); continue; }
      try {
        let normalizedVal = val;
        if (STRATEGY_BIN_KEYS.has(match[0])) {
          const numericVal = Number(val);
          if (!Number.isFinite(numericVal)) {
            throw new Error(`${match[0]} must be a finite number`);
          }
          normalizedVal = Math.max(MIN_SAFE_BINS_BELOW, Math.round(numericVal));
        } else {
          normalizedVal = normalizeConfigValue(match[0], val);
        }
        applied[match[0]] = normalizedVal;
      } catch (error) {
        return { success: false, error: error.message, key: match[0], reason };
      }
    }

    if (Object.keys(applied).length === 0) {
      log("config", `update_config failed — unknown keys: ${JSON.stringify(unknown)}, raw changes: ${JSON.stringify(changes)}`);
      return { success: false, unknown, reason };
    }

    let userConfig = {};
    if (fs.existsSync(USER_CONFIG_PATH)) {
      try {
        userConfig = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      } catch (error) {
        return { success: false, error: `Invalid user-config.json: ${error.message}`, reason };
      }
    }

    // Apply to live config immediately after the persisted config is known-good.
    for (const [key, val] of Object.entries(applied)) {
      const [section, field] = CONFIG_MAP[key];
      const before = config[section][field];
      config[section][field] = val;
      log("config", `update_config: config.${section}.${field} ${before} → ${val} (verify: ${config[section][field]})`);
    }
    if (
      applied.binsBelow != null ||
      applied.minBinsBelow != null ||
      applied.maxBinsBelow != null ||
      applied.defaultBinsBelow != null
    ) {
      config.strategy.minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Math.round(Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW)));
      config.strategy.maxBinsBelow = Math.max(config.strategy.minBinsBelow, Math.round(Number(config.strategy.maxBinsBelow ?? config.strategy.minBinsBelow)));
      config.strategy.defaultBinsBelow = Math.max(
        config.strategy.minBinsBelow,
        Math.min(
          config.strategy.maxBinsBelow,
          Math.round(Number(config.strategy.defaultBinsBelow ?? config.strategy.maxBinsBelow)),
        ),
      );
    }

    for (const [key, val] of Object.entries(applied)) {
      const persistPath = CONFIG_MAP[key]?.[2];
      if (Array.isArray(persistPath) && persistPath.length > 0) {
        let target = userConfig;
        for (const part of persistPath.slice(0, -1)) {
          if (!target[part] || typeof target[part] !== "object" || Array.isArray(target[part])) {
            target[part] = {};
          }
          target = target[part];
        }
        target[persistPath[persistPath.length - 1]] = val;
      } else {
        userConfig[key] = val;
      }
    }
    userConfig._lastAgentTune = new Date().toISOString();
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(userConfig, null, 2));

    // Restart cron jobs if intervals changed
    const intervalChanged = applied.managementIntervalMin != null || applied.screeningIntervalMin != null;
    if (intervalChanged && _cronRestarter) {
      _cronRestarter();
      log("config", `Cron restarted — management: ${config.schedule.managementIntervalMin}m, screening: ${config.schedule.screeningIntervalMin}m`);
    }

    // Skip repeated volatility-driven interval changes; they are operational tuning, not reusable lessons.
    const lessonsKeys = Object.keys(applied).filter(
      k => k !== "managementIntervalMin" && k !== "screeningIntervalMin"
    );
    if (lessonsKeys.length > 0) {
      const summary = lessonsKeys.map(k => `${k}=${applied[k]}`).join(", ");
      addLesson(`[SELF-TUNED] Changed ${summary} — ${reason}`, ["self_tune", "config_change"]);
    }

    log("config", `Agent self-tuned: ${JSON.stringify(applied)} — ${reason}`);
    return { success: true, applied, unknown, reason };
  },
};

// Tools that modify on-chain state (need extra safety checks)
const WRITE_TOOLS = new Set([
  "deploy_position",
  "claim_fees",
  "close_position",
  "swap_token",
]);
const PROTECTED_TOOLS = new Set([
  ...WRITE_TOOLS,
  "self_update",
]);

/**
 * Execute a tool call with safety checks and logging.
 */
export async function executeTool(name, args) {
  const startTime = Date.now();

  // Strip model artifacts like "<|channel|>commentary" appended to tool names
  name = name.replace(/<.*$/, "").trim();

  // ─── Validate tool exists ─────────────────
  const fn = toolMap[name];
  if (!fn) {
    const error = `Unknown tool: ${name}`;
    log("error", error);
    return { error };
  }

  // ─── Pre-execution safety checks ──────────
  let safetyCheck = null;
  if (PROTECTED_TOOLS.has(name)) {
    safetyCheck = await runSafetyChecks(name, args);
    if (!safetyCheck.pass) {
      console.log(`[SAFETY_BLOCK] ${name} blocked: ${safetyCheck.reason}`);
      log("safety_block", `${name} blocked: ${safetyCheck.reason}`);
      return {
        blocked: true,
        reason: safetyCheck.reason,
      };
    }
  }

  // ─── Execute ──────────────────────────────
  try {
    const result = await fn(args);
    const duration = Date.now() - startTime;
    const success = result?.success !== false && !result?.error;

    logAction({
      tool: name,
      args,
      result: summarizeResult(result),
      duration_ms: duration,
      success,
    });

    if (success) {
      if (name === "swap_token" && result.tx) {
        notifySwap({ inputSymbol: args.input_mint?.slice(0, 8), outputSymbol: args.output_mint === "So11111111111111111111111111111111111111112" || args.output_mint === "SOL" ? "SOL" : args.output_mint?.slice(0, 8), amountIn: result.amount_in, amountOut: result.amount_out, tx: result.tx }).catch(() => {});
      } else if (name === "deploy_position") {
        notifyDeploy({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, position: result.position, tx: result.txs?.[0] ?? result.tx, priceRange: result.price_range, rangeCoverage: result.range_coverage, binStep: result.bin_step, baseFee: result.base_fee }).catch(() => {});
        if (getStrategyMode() === "dumpcatch" && safetyCheck?._dcSupertrend) {
          notifyDumpCatchEntry({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), amountSol: args.amount_y ?? args.amount_sol ?? 0, bins: args.bins_below, fibLevel: safetyCheck._dcFibLevel ?? "—", supertrendFlip: safetyCheck._dcSupertrend.candlesSinceFlip }).catch(() => {});
        }
        if (safetyCheck?.highConviction && result.position) {
          notifyHighConviction({ pair: result.pool_name || args.pool_name || args.pool_address?.slice(0, 8), ageHours: safetyCheck.tokenAgeHours, score: safetyCheck.score, organic: safetyCheck.organicScore, feeTvlRatio: safetyCheck.feeTvlRatio, amountSol: args.amount_y ?? args.amount_sol ?? 0, hcTier: safetyCheck.hcTier ?? 1, tierWindow: safetyCheck.tierWindow }).catch(() => {});
        }
        if (safetyCheck?.discordFastTrack && result.position) {
          markDiscordSignalPosition(result.position);
          console.log(`[DISCORD_SIGNAL] Position ${result.position} marked — tight exit rules: SL -5%, trailing TP 5%/2%, max age 24h`);
        }
      } else if (name === "close_position") {
        const _closedTracked = result.position ? getTrackedPosition(result.position) : null;
        const _closedMode = _closedTracked?.openedInMode ?? "conservative";
        const _closeReason = args.reason ?? "";
        if (_closedMode === "dumpcatch") {
          if (_closeReason.includes("DC_SL") || _closeReason.includes("hard stop")) {
            notifyDumpCatchSL({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlPct: result.pnl_pct ?? 0, pnlSol: result.pnl_usd ?? 0, heldMinutes: result.minutes_held ?? null }).catch(() => {});
          } else if (_closeReason.includes("DC_BOUNCE") || _closeReason.includes("bounce confirmed")) {
            const _dcRsiVal = _closeReason.match(/RSI\(2\)=([\d.]+)/)?.[1];
            notifyDumpCatchExit({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlPct: result.pnl_pct ?? 0, pnlSol: result.pnl_usd ?? 0, rsi: _dcRsiVal ?? 0, heldMinutes: result.minutes_held ?? null }).catch(() => {});
          } else {
            notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0, feesUsd: result.fees_usd ?? null, reason: _closeReason || null, heldMinutes: result.minutes_held ?? null }).catch(() => {});
          }
        } else {
          notifyClose({ pair: result.pool_name || args.position_address?.slice(0, 8), pnlUsd: result.pnl_usd ?? 0, pnlPct: result.pnl_pct ?? 0, feesUsd: result.fees_usd ?? null, reason: _closeReason || null, heldMinutes: result.minutes_held ?? null }).catch(() => {});
        }
        if (result.base_mint) recordClosedToken(result.base_mint, args.reason ?? null);
        // Note low-yield closes in pool memory so screener avoids redeploying
        if (args.reason && args.reason.toLowerCase().includes("yield")) {
          const poolAddr = result.pool || args.pool_address;
          if (poolAddr) addPoolNote({ pool_address: poolAddr, note: `Closed: low yield (fee/TVL below threshold) at ${new Date().toISOString().slice(0,10)}` }).catch?.(() => {});
        }
        // Auto-swap base token back to SOL unless user said to hold
        if (!args.skip_swap && result.base_mint) {
          try {
            const balances = await getWalletBalances({});
            const token = balances.tokens?.find(t => t.mint === result.base_mint);
            if (token && token.usd >= 0.10) {
              // Log Jupiter exit quote for observation before swapping
              try {
                const quote = await getSwapQuote({ inputMint: result.base_mint, outputMint: "So11111111111111111111111111111111111111112", amount: token.balance });
                if (quote) {
                  const outSol = quote.outAmount ? (parseInt(quote.outAmount) / 1e9).toFixed(4) : "?";
                  log("executor", `[JUPITER_EXIT_QUOTE] ${token.symbol || result.base_mint.slice(0, 8)} $${token.usd.toFixed(2)} → ~${outSol} SOL (priceImpact: ${quote.priceImpactPct ?? "?"}%)`);
                }
              } catch (qe) {
                log("executor_warn", `[JUPITER_ERROR] Exit quote failed: ${qe.message}`);
              }
              log("executor", `Auto-swapping ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
              const swapResult = await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
              // Tell the model the swap already happened so it doesn't call swap_token again
              result.auto_swapped = true;
              result.auto_swap_note = `Base token already auto-swapped back to SOL (${token.symbol || result.base_mint.slice(0, 8)} → SOL). Do NOT call swap_token again.`;
              if (swapResult?.amount_out) result.sol_received = swapResult.amount_out;
            }
          } catch (e) {
            log("executor_warn", `Auto-swap after close failed: ${e.message}`);
          }
        }
      } else if (name === "claim_fees" && config.management.autoSwapAfterClaim && result.base_mint) {
        try {
          const balances = await getWalletBalances({});
          const token = balances.tokens?.find(t => t.mint === result.base_mint);
          if (token && token.usd >= 0.10) {
            log("executor", `Auto-swapping claimed ${token.symbol || result.base_mint.slice(0, 8)} ($${token.usd.toFixed(2)}) back to SOL`);
            await swapToken({ input_mint: result.base_mint, output_mint: "SOL", amount: token.balance });
          }
        } catch (e) {
          log("executor_warn", `Auto-swap after claim failed: ${e.message}`);
        }
      }
    }

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    logAction({
      tool: name,
      args,
      error: error.message,
      duration_ms: duration,
      success: false,
    });

    // Return error to LLM so it can decide what to do
    return {
      error: error.message,
      tool: name,
    };
  }
}

/**
 * Run safety checks before executing write operations.
 */
async function runSafetyChecks(name, args) {
  switch (name) {
    case "deploy_position": {
      const poolThresholds = await validateDeployPoolThresholds(args);
      if (!poolThresholds.pass) return poolThresholds;

      // ── Fix 4: Minimum R:R check ─────────────────────────────
      // Treat feeActiveTvlRatio as daily fee yield (decimal). Expected 2-day return must >= 4%.
      const poolFeeRatio = poolThresholds.feeActiveTvlRatio;
      const rrExpected = poolFeeRatio != null ? poolFeeRatio * 2 * 100 : null; // % over 2 days
      const rrRisk = Math.abs(config.management.stopLossPct ?? 8);
      if (rrExpected != null) {
        if (rrExpected < 4) {
          const msg = `[SAFETY] R:R FAIL — expected fees ${rrExpected.toFixed(1)}% vs risk ${rrRisk}% — skipping`;
          log("safety", msg);
          return { pass: false, reason: `R:R check failed: expected 2-day fees ${rrExpected.toFixed(1)}% < 4% minimum (fee/TVL ratio ${(poolFeeRatio * 100).toFixed(2)}%)` };
        }
        log("safety", `[SAFETY] R:R PASS — expected fees ${rrExpected.toFixed(1)}% vs risk ${rrRisk}% — deploying`);
      }

      // Reject pools with bin_step out of configured range
      const minStep = config.screening.minBinStep;
      const maxStep = config.screening.maxBinStep;
      if (args.bin_step != null && (args.bin_step < minStep || args.bin_step > maxStep)) {
        return {
          pass: false,
          reason: `bin_step ${args.bin_step} is outside the allowed range of [${minStep}-${maxStep}].`,
        };
      }

      const deployAmountY = Number(args.amount_y ?? args.amount_sol ?? 0);
      const deployAmountX = Number(args.amount_x ?? 0);
      if (Number.isFinite(deployAmountX) && deployAmountX > 0) {
        return {
          pass: false,
          reason: "This agent only supports single-side SOL deploys. Use amount_y/amount_sol and keep amount_x=0.",
        };
      }
      const requestedBinsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? config.strategy.minBinsBelow);
      const requestedBinsAbove = Number(args.bins_above ?? 0);
      const minBinsBelow = Math.max(MIN_SAFE_BINS_BELOW, Number(config.strategy.minBinsBelow ?? MIN_SAFE_BINS_BELOW));
      const isSingleSidedSol = deployAmountY > 0 && deployAmountX <= 0;
      const requestedTotalBins = requestedBinsBelow + requestedBinsAbove;
      const requestedVolatility = args.volatility == null ? null : Number(args.volatility);
      if (args.volatility != null && (!Number.isFinite(requestedVolatility) || requestedVolatility <= 0)) {
        return {
          pass: false,
          reason: `volatility ${args.volatility} is invalid. Refusing deploy because the volatility feed is unusable.`,
        };
      }
      if (
        args.downside_pct == null &&
        args.upside_pct == null &&
        (
          !Number.isFinite(requestedBinsBelow) ||
          !Number.isFinite(requestedBinsAbove) ||
          !Number.isInteger(requestedBinsBelow) ||
          !Number.isInteger(requestedBinsAbove) ||
          requestedBinsBelow < 0 ||
          requestedBinsAbove < 0 ||
          requestedTotalBins < minBinsBelow
        )
      ) {
        return {
          pass: false,
          reason: `deploy range ${requestedTotalBins} total bins is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      if (
        isSingleSidedSol &&
        args.downside_pct == null &&
        (!Number.isFinite(requestedBinsBelow) || !Number.isInteger(requestedBinsBelow) || requestedBinsBelow < minBinsBelow)
      ) {
        return {
          pass: false,
          reason: `bins_below ${args.bins_below ?? "missing"} is below minimum ${minBinsBelow}. Refusing 1-bin/tiny-range deploy.`,
        };
      }
      // bins_above may be > 0 even for single-side SOL (upper bins are empty stubs that
      // define the price ceiling without requiring token X). Allowing this is what makes
      // the price centering check meaningful for single-side deploys.
      if (
        isSingleSidedSol &&
        args.upside_pct == null &&
        (!Number.isFinite(requestedBinsAbove) || !Number.isInteger(requestedBinsAbove) || requestedBinsAbove < 0)
      ) {
        return {
          pass: false,
          reason: "bins_above must be a non-negative integer.",
        };
      }

      // Check position count limit + duplicate pool guard — force fresh scan to avoid stale cache
      const positions = await getMyPositions({ force: true });
      if (positions.total_positions >= config.risk.maxPositions) {
        return {
          pass: false,
          reason: `Max positions (${config.risk.maxPositions}) reached. Close a position first.`,
        };
      }
      const alreadyInPool = positions.positions.some(
        (p) => p.pool === args.pool_address
      );
      if (alreadyInPool) {
        return {
          pass: false,
          reason: `Already have an open position in pool ${args.pool_address}. Cannot open duplicate.`,
        };
      }

      // Block same base token across different pools — base_mint is required
      if (!args.base_mint) {
        return {
          pass: false,
          reason: "base_mint is required to verify no duplicate token position exists. Provide base_mint and retry.",
        };
      }
      const alreadyHasMint = positions.positions.some(
        (p) => p.base_mint === args.base_mint
      );
      if (alreadyHasMint) {
        return {
          pass: false,
          reason: `Already holding base token ${args.base_mint} in another pool. One position per token only.`,
        };
      }

      // Strategy 1: re-entry cooldown — block if this mint was closed < 4h ago
      if (isTokenOnCooldown(args.base_mint)) {
        const msg = `[SAFETY] Re-entry blocked: ${args.base_mint.slice(0, 8)}... was closed less than 4 hours ago — cooldown active`;
        log("safety", msg);
        return { pass: false, reason: msg };
      }

      // Strategy 3: BTC downtrend — block all new opens when BTC is in freefall
      try {
        const btc = await checkBtcTrend();
        if (btc.blocked) {
          log("safety", btc.reason);
          return { pass: false, reason: btc.reason };
        }
      } catch (e) {
        log("executor_warn", `BTC trend check failed: ${e.message}`);
      }

      // ── Price velocity circuit breaker ────────────────────────────
      // Hardcoded strategy is set here too (single OKX fetch for both).
      let _volatility24h = null;
      let _strategyLabel = null;
      try {
        const velocity = await checkPriceVelocity(args.base_mint);
        if (velocity.deploy_blocked) {
          log("safety", `[SAFETY] Price velocity block — rapid dump detected for ${args.base_mint}: ${velocity.reason}`);
          return { pass: false, reason: velocity.reason };
        }
        // volatility_blocked removed — price velocity covers this already

        const range24h = Math.abs(velocity.price_change_24h ?? velocity.price_change_1h ?? 0);
        _volatility24h = range24h;

        // ── Hardcoded distribution strategy (LLM never chooses this) ──
        // HARDCODED STRATEGY — curve removed entirely
        let hardcodedStrategy;
        if (range24h >= 5) {
          hardcodedStrategy = "bid_ask";
        } else {
          hardcodedStrategy = "spot";
        }
        args.strategy = hardcodedStrategy;
        _strategyLabel = hardcodedStrategy === "bid_ask" ? "BID-ASK (balanced)" : "SPOT (SOL-only)";
        log("strategy", `[STRATEGY] Hardcoded: ${hardcodedStrategy} (volatility: ${range24h.toFixed(1)}%)`);

        // DEPLOYMENT MODE: spot = single-side SOL only
        if (hardcodedStrategy === "spot") {
          // Spot needs an upside buffer — at least 30% of bins_below so a pump doesn't cause instant OOR.
          // The bins above are empty (no token X), they just set the upper range boundary.
          const binsBelow = Number(args.bins_below ?? config.strategy.minBinsBelow);
          const minBinsAbove = Math.floor(binsBelow * 0.30);
          const currentBinsAbove = Number(args.bins_above ?? 0);
          if (currentBinsAbove < minBinsAbove) {
            args.bins_above = minBinsAbove;
            log("strategy", `[SAFETY_AUTOCORRECT] spot bins_above too low (was ${currentBinsAbove}) — set to 30% of bins_below (${minBinsAbove})`);
          }
          log("strategy", `[STRATEGY] Spot: single-side SOL — bins_below=${binsBelow} bins_above=${args.bins_above}`);
        } else {
          // bid_ask must be balanced — bins_above must equal bins_below
          // LLM prompts say bins_above=0 for single-side SOL, so auto-correct here
          if (!args.bins_above || args.bins_above === 0) {
            const corrected = Number(args.bins_below ?? config.strategy.minBinsBelow);
            args.bins_above = corrected;
            log("strategy", `[SAFETY_AUTOCORRECT] bid_ask bins_above set to match bins_below (${corrected}) — was 0`);
          }
          log("strategy", "[STRATEGY] Bid-ask: balanced — fees both directions");
        }

        // Adjust bins_below based on 24h price range
        if (range24h > 0 && args.bins_below != null) {
          const minBins = config.strategy.minBinsBelow;
          const maxBins = config.strategy.maxBinsBelow;
          let targetBins = args.bins_below;
          if (range24h > 15) {
            targetBins = Math.max(args.bins_below, Math.round(minBins + 0.75 * (maxBins - minBins)));
          } else if (range24h < 8) {
            targetBins = Math.min(args.bins_below, Math.round(minBins + 0.40 * (maxBins - minBins)));
          }
          targetBins = Math.max(minBins, Math.min(maxBins, targetBins));
          if (targetBins !== args.bins_below) {
            log("strategy", `[STRATEGY] Bin range adjusted: ${range24h.toFixed(1)}% 24h → bins_below ${args.bins_below} → ${targetBins}`);
            args.bins_below = targetBins;
          }
        }
      } catch (e) {
        log("executor_warn", `Price velocity check failed for ${args.base_mint}: ${e.message}`);
      }

      // ── Dump Catch Mode checks ────────────────────────────────────
      const _dcStrategyMode = getStrategyMode();
      let _dcSupertrend = null;
      let _dcBinSelection = null;
      if (_dcStrategyMode === "dumpcatch") {
        // 1. Time filter: block entries 22:00–06:00 UTC
        const _dcHour = new Date().getUTCHours();
        if (_dcHour >= 22 || _dcHour < 6) {
          const msg = `[DUMP CATCH] Entry blocked — outside trading hours (${_dcHour}:00 UTC). No entries 22:00–06:00 UTC.`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }

        // 2. Higher volume requirement
        const _dcVolume = args.volume_usd ?? args.volume ?? 0;
        if (_dcVolume < 1_000_000) {
          const msg = `[DUMP CATCH] Entry blocked — volume $${(_dcVolume/1000).toFixed(0)}k below $1M minimum for dump catch mode.`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }

        // 3. Higher MC requirement
        const _dcMcap = args.market_cap ?? args.mcap ?? 0;
        if (_dcMcap < 250_000) {
          const msg = `[DUMP CATCH] Entry blocked — market cap $${(_dcMcap/1000).toFixed(0)}k below $250k minimum for dump catch mode.`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }

        // 4. Fetch 15m candles and calculate Supertrend
        const _dcSymbol = args.token_symbol ?? args.symbol ?? args.base_mint;
        const _dcCandles = await fetch15mCandles(_dcSymbol, 100);
        if (!_dcCandles || _dcCandles.length < 30) {
          const msg = `[DUMP CATCH] Entry blocked — insufficient 15m candle data for ${_dcSymbol} (token may not be listed on OKX spot).`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }

        // 5. Require bullish Supertrend that flipped within last 5 candles
        _dcSupertrend = calculateSupertrend(_dcCandles, 10, 3);
        if (!_dcSupertrend) {
          const msg = `[DUMP CATCH] Entry blocked — could not calculate Supertrend (insufficient candles).`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }
        if (_dcSupertrend.trend !== "bullish") {
          const msg = `[DUMP CATCH] Entry blocked — Supertrend is bearish. Waiting for bullish flip before entry.`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }
        if (_dcSupertrend.candlesSinceFlip > 5) {
          const msg = `[DUMP CATCH] Entry blocked — Supertrend flipped ${_dcSupertrend.candlesSinceFlip} candles ago (max 5). Bounce window has passed.`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }
        log("safety", `[DUMP CATCH] Supertrend bullish ✅ — flipped ${_dcSupertrend.candlesSinceFlip} candle(s) ago, value=${_dcSupertrend.value?.toFixed(6)}`);

        // 6. Calculate ATH from candle data and derive Fib levels
        const _dcAth = Math.max(..._dcCandles.map(c => c.high));
        const _dcFibLevels = calculateFibLevels(_dcAth);
        log("safety", `[DUMP CATCH] ATH=${_dcAth.toFixed(6)} Fib100bins=${_dcFibLevels.level_100bins.toFixed(6)} Fib125bins=${_dcFibLevels.level_125bins.toFixed(6)}`);

        // 7. Select bin count based on Supertrend position vs Fib levels
        _dcBinSelection = selectBinsBySupertrendPosition(_dcSupertrend.value, _dcFibLevels);
        log("safety", `[DUMP CATCH] Bin selection: ${_dcBinSelection.bins} bins (${_dcBinSelection.rangeDesc})`);

        // 8. Override deployment settings for dump catch
        args.bins_below = _dcBinSelection.bins;
        args.bins_above = 0;
        args.strategy = "spot";
        log("safety", `[DUMP CATCH] Overriding deploy: bins_below=${args.bins_below}, bins_above=0, strategy=spot`);

        // 9. Skip normal centering check (dump catch uses fib-based bin sizing, not symmetry)
        // Mark with a flag so centering check below is bypassed
        args._skipCenteringCheck = true;
      }

      // ── Price centering check ─────────────────────────────────────
      // Runs for ALL deploys. spot+bins_above=0 is exempted (intentional single-side SOL).
      // Dump catch mode sets _skipCenteringCheck=true (fib-based sizing, no symmetry needed).
      let _pricePct = null;
      if (args._skipCenteringCheck) {
        log("safety", "[SAFETY] Price centering skipped — dump catch mode (fib-based bin sizing)");
        delete args._skipCenteringCheck;
        // fall through to deploy
      } else {
      const binsAboveRequested = Number(args.bins_above ?? 0);
      const strategyForCentering = (args.strategy || config.strategy.strategy || "bid_ask").toLowerCase();
      const binsBelow = Number(args.bins_below ?? config.strategy.defaultBinsBelow ?? 50);
      const totalBins = binsBelow + binsAboveRequested;
      // pctFromBottom: where the active bin sits within the proposed range (0=bottom, 100=top)
      const pctFromBottom = totalBins > 0 ? (binsBelow / totalBins) * 100 : 100;

      log("safety", `[SAFETY] Price centering: bins_below=${binsBelow} bins_above=${binsAboveRequested} percentile=${pctFromBottom.toFixed(1)}% strategy=${strategyForCentering}`);

      if (binsAboveRequested === 0 && strategyForCentering === "bid_ask") {
        // bid_ask with bins_above=0: price at 100th percentile — guaranteed OOR on any upward move
        const msg = `[SAFETY] Price centering block — bins_above=0 with bid_ask strategy is an edge deployment. Any upward tick causes immediate OOR. Provide bins_above > 0.`;
        log("safety", msg);
        return { pass: false, reason: msg };
      }

      if (strategyForCentering === "spot" && binsAboveRequested === 0) {
        // Single-side SOL — price naturally sits near top of range.
        // Only block if active bin is within 3 bins of upper boundary (instant OOR guaranteed).
        const activeBin = args.active_bin || 0;
        const upperBound = activeBin + (args.bins_below || 0);
        const binsFromEdge = upperBound - activeBin;
        if (binsFromEdge <= 3) {
          const msg = `[SAFETY] Spot edge block — active bin within ${binsFromEdge} bins of upper boundary. Instant OOR guaranteed.`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }
        log("strategy", `[STRATEGY] Spot single-side SOL — ${binsFromEdge} bins buffer from edge ✅`);
        // proceed to deploy
      } else if (strategyForCentering === "spot" && binsAboveRequested < Math.floor(binsBelow * 0.20)) {
        // Lopsided spot range — bins_above is less than 20% of bins_below after autocorrect.
        // This means price is too close to the top and any pump causes immediate OOR.
        const msg = `[SAFETY] Spot range too lopsided — bins_above ${binsAboveRequested} is less than 20% of bins_below ${binsBelow}. Deploy would cause immediate OOR on any upward move.`;
        log("safety", msg);
        return { pass: false, reason: msg };
      } else if (strategyForCentering === "spot") {
        // Spot is intentionally asymmetric (single-side SOL — bins_above are empty upside stubs).
        // pctFromBottom will always be ~77% after the 30% autocorrect floor, making the symmetric
        // centering check mathematically broken for spot. Edge/lopsided checks above are sufficient.
        log("safety", `[SAFETY] Spot strategy — pctFromBottom check skipped (asymmetric by design, pct=${pctFromBottom.toFixed(1)}%)`);
        // proceed to deploy
      } else if (totalBins > 0) {
        _pricePct = pctFromBottom;
        if (pctFromBottom < 25) {
          const msg = `[SAFETY] Price centering block — price at ${pctFromBottom.toFixed(0)}th percentile (bins_below=${binsBelow}, bins_above=${binsAboveRequested}). Too close to lower boundary — immediate OOR risk on downward move.`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }
        if (pctFromBottom > 75) {
          const msg = `[SAFETY] Price centering block — price at ${pctFromBottom.toFixed(0)}th percentile (bins_below=${binsBelow}, bins_above=${binsAboveRequested}). Too close to upper boundary — immediate OOR risk on upward move.`;
          log("safety", msg);
          return { pass: false, reason: msg };
        }
        log("safety", `[SAFETY] Price centering PASS — price at ${pctFromBottom.toFixed(0)}th percentile (25th-75th allowed)`);
      }
      } // end else (_skipCenteringCheck)

      // Check amount limits
      const amountY = deployAmountY;
      if (!Number.isFinite(amountY) || amountY <= 0) {
        return {
          pass: false,
          reason: `Must provide a positive SOL amount (amount_y).`,
        };
      }

      const minDeploy = Math.max(0.1, config.management.deployAmountSol);
      if (amountY < minDeploy) {
        return {
          pass: false,
          reason: `Amount ${amountY} SOL is below the minimum deploy amount (${minDeploy} SOL). Use at least ${minDeploy} SOL.`,
        };
      }
      if (amountY > config.risk.maxDeployAmount) {
        return {
          pass: false,
          reason: `SOL amount ${amountY} exceeds maximum allowed per position (${config.risk.maxDeployAmount}).`,
        };
      }

      // Check SOL balance
      if (process.env.DRY_RUN !== "true") {
        const balance = await getWalletBalances();
        const gasReserve = config.management.gasReserve;
        const minRequired = amountY + gasReserve;
        if (balance.sol < minRequired) {
          return {
            pass: false,
            reason: `Insufficient SOL: have ${balance.sol} SOL, need ${minRequired} SOL (${amountY} deploy + ${gasReserve} gas reserve).`,
          };
        }
      }

      // ── Jupiter vs OKX price check (always runs) ─────────────
      // Fetch both prices independently — never relies on LLM-supplied args.
      if (args.base_mint) {
        try {
          const [jup, okxInfo] = await Promise.all([
            getJupiterPrice(args.base_mint),
            getPriceInfo(args.base_mint),
          ]);
          const jupPrice = jup?.price;
          const okxPrice = okxInfo?.price;
          if (jupPrice != null && okxPrice != null && Number.isFinite(jupPrice) && Number.isFinite(okxPrice) && okxPrice > 0) {
            const pctDiff = Math.abs((jupPrice - okxPrice) / okxPrice) * 100;
            if (pctDiff > 5) {
              const msg = `[PRICE_CHECK] FAIL — Jupiter $${jupPrice.toFixed(6)} vs OKX $${okxPrice.toFixed(6)} — ${pctDiff.toFixed(1)}% divergence exceeds 5% threshold. Skipping deploy.`;
              console.log('[PRICE_CHECK]', msg);
              log("safety", msg);
              return { pass: false, reason: msg };
            }
            const passMsg = `[PRICE_CHECK] PASS — Jupiter $${jupPrice.toFixed(6)} vs OKX $${okxPrice.toFixed(6)} — ${pctDiff.toFixed(1)}% within tolerance`;
            console.log('[PRICE_CHECK]', passMsg);
            log("safety", passMsg);
          } else {
            const skipMsg = `[PRICE_CHECK] SKIP — one or both prices unavailable (Jupiter: ${jupPrice ?? "n/a"}, OKX: ${okxPrice ?? "n/a"})`;
            console.log('[PRICE_CHECK]', skipMsg);
            log("safety", skipMsg);
          }
        } catch (e) {
          console.log(`[PRICE_CHECK] Error during price check: ${e.message}`);
          log("executor_warn", `[PRICE_CHECK] Error during price check: ${e.message}`);
        }
      }

      // Store meta for Telegram screening report enrichment
      _lastDeployMeta = {
        rrExpected: rrExpected != null ? parseFloat(rrExpected.toFixed(1)) : null,
        rrRisk,
        strategyLabel: _strategyLabel,
        pricePct: _pricePct != null ? parseFloat(_pricePct.toFixed(0)) : null,
      };

      // Pass dump catch indicator data through for deploy notification
      const _dcPassthrough = _dcStrategyMode === "dumpcatch" ? { _dcSupertrend: _dcSupertrend ?? null, _dcFibLevel: _dcBinSelection?.rangeDesc ?? null } : {};
      return { pass: true, ..._dcPassthrough };
    }

    case "swap_token": {
      // Basic check — prevent swapping when DRY_RUN is true
      // (handled inside swapToken itself, but belt-and-suspenders)
      return { pass: true };
    }

    case "self_update": {
      if (process.env.ALLOW_SELF_UPDATE !== "true") {
        return {
          pass: false,
          reason: "self_update is disabled by default. Set ALLOW_SELF_UPDATE=true locally if you really want to enable it.",
        };
      }
      if (!process.stdin.isTTY) {
        return {
          pass: false,
          reason: "self_update is only allowed from a local interactive TTY session, not from Telegram or background automation.",
        };
      }
      return { pass: true };
    }

    default:
      return { pass: true };
  }
}

/**
 * Summarize a result for logging (truncate large responses).
 */
function summarizeResult(result) {
  const str = JSON.stringify(result);
  if (str.length > 1000) {
    return str.slice(0, 1000) + "...(truncated)";
  }
  return result;
}
