import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { log } from "./logger.js";
import { getCachedSolPrice } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USER_CONFIG_PATH = path.join(__dirname, "user-config.json");

const TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const BASE  = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;

// ─── Formatting helpers ──────────────────────────────────────────
const SEP = "━━━━━━━━━━━━━━━━━━━━━━━";

function escHtml(str) {
  return String(str ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtAge(minutes) {
  const m = Math.round(Number(minutes) || 0);
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h === 0) return `${rem}m`;
  return rem === 0 ? `${h}h` : `${h}h ${rem}m`;
}

function fmtUtcTime(d = new Date()) {
  return (d instanceof Date ? d : new Date()).toISOString().slice(11, 16) + " UTC";
}

function fmtUtcDate(d = new Date()) {
  return (d instanceof Date ? d : new Date()).toLocaleDateString("en-US", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
}

// Convert a USD amount to SOL using the cached live price
function usdToSol(usd) {
  const price = getCachedSolPrice();
  return price > 0 ? (Number(usd) || 0) / price : 0;
}

// Format a SOL amount — 6 decimal places for tiny amounts, 4 otherwise
function fmtSol(sol) {
  const n = Number(sol) || 0;
  return n !== 0 && Math.abs(n) < 0.001 ? `${n.toFixed(6)} SOL` : `${n.toFixed(4)} SOL`;
}

// Format signed SOL PnL with percentage context: "+0.0072 SOL (+2.56%)"
function fmtSolPnl(sol, pct) {
  const s = Number(sol) || 0;
  const p = Number(pct) || 0;
  const sign = s >= 0 ? "+" : "-";
  return `${sign}${Math.abs(s).toFixed(4)} SOL (${p >= 0 ? "+" : ""}${p.toFixed(2)}%)`;
}
const ALLOWED_USER_IDS = new Set(
  String(process.env.TELEGRAM_ALLOWED_USER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);

let chatId   = process.env.TELEGRAM_CHAT_ID || null;
let _offset  = 0;
let _polling = false;
let _liveMessageDepth = 0;
let _warnedMissingChatId = false;
let _warnedMissingAllowedUsers = false;

// ─── chatId persistence ──────────────────────────────────────────
function loadChatId() {
  try {
    if (fs.existsSync(USER_CONFIG_PATH)) {
      const cfg = JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"));
      if (cfg.telegramChatId) chatId = cfg.telegramChatId;
    }
  } catch (error) {
    log("telegram_warn", `Invalid user-config.json; chatId not loaded: ${error.message}`);
  }
}

function saveChatId(id) {
  try {
    let cfg = fs.existsSync(USER_CONFIG_PATH)
      ? JSON.parse(fs.readFileSync(USER_CONFIG_PATH, "utf8"))
      : {};
    cfg.telegramChatId = id;
    fs.writeFileSync(USER_CONFIG_PATH, JSON.stringify(cfg, null, 2));
  } catch (e) {
    log("telegram_error", `Failed to persist chatId: ${e.message}`);
  }
}

loadChatId();

function isAuthorizedIncomingMessage(msg) {
  const incomingChatId = String(msg.chat?.id || "");
  const senderUserId = msg.from?.id != null ? String(msg.from.id) : null;
  const chatType = msg.chat?.type || "unknown";

  if (!chatId) {
    if (!_warnedMissingChatId) {
      log("telegram_warn", "Ignoring inbound Telegram messages because TELEGRAM_CHAT_ID / user-config.telegramChatId is not configured. Auto-registration is disabled for safety.");
      _warnedMissingChatId = true;
    }
    return false;
  }

  if (incomingChatId !== chatId) return false;

  if (chatType !== "private" && ALLOWED_USER_IDS.size === 0) {
    if (!_warnedMissingAllowedUsers) {
      log("telegram_warn", "Ignoring group Telegram messages because TELEGRAM_ALLOWED_USER_IDS is not configured. Set explicit allowed user IDs for command/control.");
      _warnedMissingAllowedUsers = true;
    }
    return false;
  }

  if (ALLOWED_USER_IDS.size > 0) {
    if (!senderUserId || !ALLOWED_USER_IDS.has(senderUserId)) return false;
  }

  return true;
}

// ─── Core send ───────────────────────────────────────────────────
export function isEnabled() {
  return !!TOKEN;
}

async function postTelegram(method, body) {
  if (!TOKEN || !chatId) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, ...body }),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

async function postTelegramRaw(method, body) {
  if (!TOKEN) return null;
  try {
    const res = await fetch(`${BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      log("telegram_error", `${method} ${res.status}: ${err.slice(0, 200)}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    log("telegram_error", `${method} failed: ${e.message}`);
    return null;
  }
}

export async function sendMessage(text) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: String(text).slice(0, 4096) });
}

export async function sendMessageWithButtons(text, inlineKeyboard) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", {
    text: String(text).slice(0, 4096),
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function sendHTML(html) {
  if (!TOKEN || !chatId) return;
  return postTelegram("sendMessage", { text: html.slice(0, 4096), parse_mode: "HTML" });
}

// Track last-sent text per message_id to avoid "message is not modified" 400 errors
const _editTextCache = new Map();

export async function editMessage(text, messageId) {
  if (!TOKEN || !chatId || !messageId) return null;
  const truncated = String(text).slice(0, 4096);
  if (_editTextCache.get(messageId) === truncated) return null;
  _editTextCache.set(messageId, truncated);
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: truncated,
  });
}

export async function editMessageWithButtons(text, messageId, inlineKeyboard) {
  if (!TOKEN || !chatId || !messageId) return null;
  const truncated = String(text).slice(0, 4096);
  const cacheKey = `${messageId}:btn`;
  const payload = JSON.stringify({ text: truncated, inlineKeyboard });
  if (_editTextCache.get(cacheKey) === payload) return null;
  _editTextCache.set(cacheKey, payload);
  return postTelegram("editMessageText", {
    message_id: messageId,
    text: truncated,
    reply_markup: { inline_keyboard: inlineKeyboard },
  });
}

export async function answerCallbackQuery(callbackQueryId, text = "") {
  if (!TOKEN || !callbackQueryId) return null;
  return postTelegramRaw("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text: String(text).slice(0, 200) } : {}),
  });
}

export function hasActiveLiveMessage() {
  return _liveMessageDepth > 0;
}

function createTypingIndicator() {
  if (!TOKEN || !chatId) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    await postTelegram("sendChatAction", { action: "typing" });
    timer = setTimeout(() => {
      tick().catch(() => null);
    }, 4000);
  }

  tick().catch(() => null);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

function toolLabel(name) {
  const labels = {
    get_token_info: "get token info",
    get_token_narrative: "get token narrative",
    get_token_holders: "get token holders",
    get_top_candidates: "get top candidates",
    get_pool_detail: "get pool detail",
    get_active_bin: "get active bin",
    deploy_position: "deploy position",
    close_position: "close position",
    claim_fees: "claim fees",
    swap_token: "swap token",
    update_config: "update config",
    get_my_positions: "get positions",
    get_wallet_balance: "get wallet balance",
    check_smart_wallets_on_pool: "check smart wallets",
    study_top_lpers: "study top LPers",
    get_top_lpers: "get top LPers",
    search_pools: "search pools",
    discover_pools: "discover pools",
  };
  return labels[name] || name.replace(/_/g, " ");
}

function summarizeToolResult(name, result) {
  if (!result) return "";
  if (result.error) return result.error;
  if (result.reason && result.blocked) return result.reason;
  switch (name) {
    case "deploy_position":
      return result.position ? `position ${String(result.position).slice(0, 8)}...` : "submitted";
    case "close_position":
      return result.success ? "closed" : (result.reason || "failed");
    case "claim_fees":
      return result.claimed_amount != null ? `claimed ${result.claimed_amount}` : "done";
    case "update_config":
      return Object.keys(result.applied || {}).join(", ") || "updated";
    case "get_top_candidates":
      return `${result.candidates?.length ?? 0} candidates`;
    case "get_my_positions":
      return `${result.total_positions ?? result.positions?.length ?? 0} positions`;
    case "get_wallet_balance":
      return `${result.sol ?? "?"} SOL`;
    case "study_top_lpers":
    case "get_top_lpers":
      return `${result.lpers?.length ?? 0} LPers`;
    default:
      return result.success === false ? "failed" : "done";
  }
}

export async function createLiveMessage(title, intro = "Starting...") {
  if (!TOKEN || !chatId) return null;
  const typing = createTypingIndicator();

  const state = {
    title,
    intro,
    toolLines: [],
    footer: "",
    messageId: null,
    flushTimer: null,
    flushPromise: null,
    flushRequested: false,
  };

  function render() {
    const sections = [state.title];
    if (state.intro) sections.push(state.intro);
    if (state.toolLines.length > 0) sections.push(state.toolLines.join("\n"));
    if (state.footer) sections.push(state.footer);
    return sections.join("\n\n").slice(0, 4096);
  }

  async function flushNow() {
    state.flushTimer = null;
    state.flushRequested = false;
    const text = render();
    if (!state.messageId) {
      const sent = await sendMessage(text);
      state.messageId = sent?.result?.message_id ?? null;
      return;
    }
    await editMessage(text, state.messageId);
  }

  function scheduleFlush(delay = 300) {
    if (state.flushTimer) {
      state.flushRequested = true;
      return;
    }
    state.flushTimer = setTimeout(() => {
      state.flushPromise = flushNow().catch(() => null);
    }, delay);
  }

  async function upsertToolLine(name, icon, suffix = "") {
    const label = toolLabel(name);
    const line = `${icon} ${label}${suffix ? ` ${suffix}` : ""}`;
    const idx = state.toolLines.findIndex((entry) => entry.includes(` ${label}`));
    if (idx >= 0) state.toolLines[idx] = line;
    else state.toolLines.push(line);
    scheduleFlush();
  }

  _liveMessageDepth += 1;
  await flushNow();

  return {
    async toolStart(name) {
      await upsertToolLine(name, "ℹ️", "...");
    },
    async toolFinish(name, result, success) {
      const icon = success ? "✅" : "❌";
      const summary = summarizeToolResult(name, result);
      await upsertToolLine(name, icon, summary ? `— ${summary}` : "");
    },
    async note(text) {
      state.intro = text;
      scheduleFlush();
    },
    async finalize(finalText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = finalText;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
    async fail(errorText) {
      if (state.flushTimer) {
        clearTimeout(state.flushTimer);
        state.flushTimer = null;
      }
      if (state.flushPromise) await state.flushPromise;
      state.footer = `❌ ${errorText}`;
      await flushNow();
      _liveMessageDepth = Math.max(0, _liveMessageDepth - 1);
      typing.stop();
    },
  };
}


// ─── Long polling ────────────────────────────────────────────────
async function poll(onMessage) {
  while (_polling) {
    try {
      const res = await fetch(
        `${BASE}/getUpdates?offset=${_offset}&timeout=30`,
        { signal: AbortSignal.timeout(35_000) }
      );
      if (!res.ok) { await sleep(5000); continue; }
      const data = await res.json();
      for (const update of data.result || []) {
        _offset = update.update_id + 1;
        const callback = update.callback_query;
        if (callback?.data && callback?.message) {
          const callbackMsg = {
            chat: callback.message.chat,
            from: callback.from,
            text: callback.data,
          };
          if (!isAuthorizedIncomingMessage(callbackMsg)) continue;
          await onMessage({
            ...callbackMsg,
            isCallback: true,
            callbackQueryId: callback.id,
            callbackData: callback.data,
            messageId: callback.message.message_id,
          });
          continue;
        }
        const msg = update.message;
        if (!msg?.text) continue;
        if (!isAuthorizedIncomingMessage(msg)) continue;
        await onMessage(msg);
      }
    } catch (e) {
      if (!e.message?.includes("aborted")) {
        log("telegram_error", `Poll error: ${e.message}`);
      }
      await sleep(5000);
    }
  }
}

export function startPolling(onMessage) {
  if (!TOKEN) return;
  _polling = true;
  poll(onMessage); // fire-and-forget
  log("telegram", "Bot polling started");
}

export function stopPolling() {
  _polling = false;
}

// ─── Notification helpers ────────────────────────────────────────
export async function notifyDeploy({ pair, amountSol, position, tx, priceRange, rangeCoverage, binStep, baseFee }) {
  if (hasActiveLiveMessage()) return;
  const rangeStr = priceRange
    ? `$${priceRange.min < 0.0001 ? priceRange.min.toExponential(3) : priceRange.min.toFixed(6)} — $${priceRange.max < 0.0001 ? priceRange.max.toExponential(3) : priceRange.max.toFixed(6)}`
    : "—";
  const now = new Date();
  await sendHTML(
`╔═══════════════════════╗
║  🟢 POSITION OPENED   ║
╚═══════════════════════╝
🪙 Token    ${escHtml(pair)}
💵 Deployed ${amountSol} SOL
📐 Bin Step ${binStep ?? "?"}
🎯 Range    ${rangeStr}
⏰ Opened   ${fmtUtcDate(now)} ${fmtUtcTime(now)}
${SEP}`
  );
}

export async function notifyTrailingTp({ pair, pnlUsd, pnlPct, feesUsd = null, heldMinutes = null, peakPnl = null, dropFromPeak = null }) {
  if (hasActiveLiveMessage()) return;
  const pnlSol = usdToSol(pnlUsd);
  const feesSol = feesUsd != null ? usdToSol(feesUsd) : null;
  const pnlStr = fmtSolPnl(pnlSol, pnlPct);
  const ageStr = heldMinutes != null ? fmtAge(heldMinutes) : "—";
  const feeStr = feesSol != null ? `\n💎 Fees     ${fmtSol(feesSol)}` : "";
  const peakStr = peakPnl != null ? `+${Number(peakPnl).toFixed(2)}%` : "—";
  const dropStr = dropFromPeak != null ? `-${Number(dropFromPeak).toFixed(2)}% from peak` : "—";
  return sendHTML(
`╔═══════════════════════╗
║   🎯 TRAILING TP      ║
╚═══════════════════════╝
🪙 Token    ${escHtml(pair)}
🏔️ Peak PnL  ${peakStr}
📉 Drop      ${dropStr}
💰 Exit PnL ${pnlStr}${feeStr}
⏱️ Held     ${ageStr}
🔒 Profit locked!
${SEP}`
  );
}

export async function notifyRecoveryExit({ pair, pnlUsd, pnlPct, feesUsd = null, heldMinutes = null, maxDd = null, recoveryPct = null }) {
  if (hasActiveLiveMessage()) return;
  const pnlSol = usdToSol(pnlUsd);
  const feesSol = feesUsd != null ? usdToSol(feesUsd) : null;
  const pnlStr = fmtSolPnl(pnlSol, pnlPct);
  const ageStr = heldMinutes != null ? fmtAge(heldMinutes) : "—";
  const feeStr = feesSol != null ? `\n💎 Fees     ${fmtSol(feesSol)}` : "";
  const ddStr = maxDd != null ? `${Number(maxDd).toFixed(2)}%` : "—";
  const recStr = recoveryPct != null ? `+${recoveryPct}% from bottom` : "—";
  return sendHTML(
`╔═══════════════════════╗
║   📈 RECOVERY EXIT    ║
╚═══════════════════════╝
🪙 Token    ${escHtml(pair)}
📉 Max DD   ${ddStr}
📈 Recovery ${recStr}
💰 Exit PnL ${pnlStr}${feeStr}
⏱️ Held     ${ageStr}
💡 Saved from deeper loss
${SEP}`
  );
}

export async function notifyClose({ pair, pnlUsd, pnlPct, feesUsd = null, reason = null, heldMinutes = null, maxDd = null, recoveryPct = null }) {
  if (hasActiveLiveMessage()) return;
  const r = String(reason || "").toLowerCase();
  const pnlSol = usdToSol(pnlUsd);
  const feesSol = feesUsd != null ? usdToSol(feesUsd) : null;
  const pnlStr = fmtSolPnl(pnlSol, pnlPct);
  const pnlEmoji = pnlSol >= 0 ? "✅" : "🔴";
  const ageStr = heldMinutes != null ? fmtAge(heldMinutes) : "—";
  const feeStr = feesSol != null ? `\n💎 Fees     ${fmtSol(feesSol)}` : "";

  if (r.includes("trailing_tp")) {
    let parsedPeakPnl = null;
    let parsedDrop = null;
    const peakMatch = r.match(/peaked\s*\+?([\d.]+)%/);
    if (peakMatch) parsedPeakPnl = parseFloat(peakMatch[1]);
    const dropMatch = r.match(/dropped?\s*([\d.]+)%/);
    if (dropMatch) parsedDrop = parseFloat(dropMatch[1]);
    return notifyTrailingTp({ pair, pnlUsd, pnlPct, feesUsd, heldMinutes, peakPnl: parsedPeakPnl, dropFromPeak: parsedDrop });
  }

  if (r.includes("drawdown_recovery")) {
    // Parse maxDd and recoveryPct from reason string if not provided directly
    // reason format: "drawdown_recovery: dropped -4.2%, recovered 68% of drawdown"
    let parsedMaxDd = maxDd;
    let parsedRecoveryPct = recoveryPct;
    if (parsedMaxDd == null) {
      const ddMatch = r.match(/dropped\s*([-\d.]+)%/);
      if (ddMatch) parsedMaxDd = parseFloat(ddMatch[1]);
    }
    if (parsedRecoveryPct == null) {
      const recMatch = r.match(/recovered\s*(\d+)%/);
      if (recMatch) parsedRecoveryPct = parseInt(recMatch[1], 10);
    }
    return notifyRecoveryExit({ pair, pnlUsd, pnlPct, feesUsd, heldMinutes, maxDd: parsedMaxDd, recoveryPct: parsedRecoveryPct });
  }

  if (r.includes("velocity") || r.includes("dump") || r.includes("safety")) {
    return sendHTML(
`╔═══════════════════════╗
║  🚨 EMERGENCY CLOSE   ║
╚═══════════════════════╝
🪙 Token    ${escHtml(pair)}
⚡ Trigger  Dump detected
💰 PnL      ${pnlStr}${feeStr}
✅ Position closed safely
${SEP}`
    );
  }

  if (r.includes("stop loss")) {
    return sendHTML(
`╔═══════════════════════╗
║   🔴 STOP LOSS HIT    ║
╚═══════════════════════╝
🪙 Token    ${escHtml(pair)}
⏱️ Held     ${ageStr}
💰 PnL      ${pnlStr}${feeStr}
📤 Reason   Stop loss triggered
🛡️ Capital  Protected
${SEP}`
    );
  }

  const isProfit = pnlSol >= 0;
  const header = isProfit
    ? "╔═══════════════════════╗\n║   ✅ POSITION CLOSED  ║\n╚═══════════════════════╝"
    : "╔═══════════════════════╗\n║   🔴 POSITION CLOSED  ║\n╚═══════════════════════╝";
  const reasonLabel = reason
    ? escHtml(String(reason).replace(/\[SAFETY\]\s*/i, "").trim().slice(0, 40))
    : "—";

  return sendHTML(
`${header}
🪙 Token    ${escHtml(pair)}
⏱️ Held     ${ageStr}
💰 PnL      ${pnlStr} ${pnlEmoji}${feeStr}
📤 Reason   ${reasonLabel}
${SEP}`
  );
}

export async function notifyOorApproaching({ pair, boundaryPct = null }) {
  if (hasActiveLiveMessage()) return;
  const boundaryStr = boundaryPct != null ? `${Math.round(boundaryPct)}% from boundary` : "Approaching boundary";
  await sendHTML(
`╔═══════════════════════╗
║   ⚠️ RANGE WARNING    ║
╚═══════════════════════╝
🪙 Token    ${escHtml(pair)}
📍 Status   ${boundaryStr}
👁️ Monitoring closely...
${SEP}`
  );
}

export async function notifyCloseFailed({ pair, attempts, reason }) {
  await sendHTML(
`╔═══════════════════════╗
║  🚨 CLOSE FAILED      ║
╚═══════════════════════╝
🪙 Token    ${escHtml(pair)}
⚠️ Attempts ${attempts}
❌ Error    ${escHtml(String(reason || "unknown").slice(0, 80))}
🔄 Will retry next cycle
${SEP}`
  );
}

export async function notifyCloseUrgent({ pair, attempts }) {
  await sendHTML(
`╔═══════════════════════╗
║ 🚨 URGENT: CLOSE FAIL ║
╚═══════════════════════╝
🪙 Token    ${escHtml(pair)}
❌ Failed   ${attempts}x — still open!
👤 Action   Close manually on Meteora
${SEP}`
  );
}

export async function notifyBtcDowntrend({ change4h, openPositions = null }) {
  const pct = typeof change4h === "number" ? change4h.toFixed(1) : "?";
  const posStr = openPositions != null
    ? `\n📂 Open    ${openPositions} position${openPositions !== 1 ? "s" : ""} monitored`
    : "";
  await sendHTML(
`╔═══════════════════════╗
║   🚨 SAFETY ALERT     ║
╚═══════════════════════╝
⚡ Type    BTC Downtrend
📉 BTC     ${pct}% in 4h
🛡️ Action  Entries suspended${posStr}
${SEP}`
  );
}

export async function notifySwap({ inputSymbol, outputSymbol, amountIn, amountOut, tx }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
`🔄 <b>Auto-Swap</b>
${escHtml(inputSymbol ?? "?")} → ${escHtml(outputSymbol ?? "?")}
In: ${amountIn ?? "?"} | Out: ${amountOut ?? "?"}
Tx: <code>${tx?.slice(0, 16) ?? "?"}...</code>`
  );
}

export async function notifyOutOfRange({ pair, minutesOOR }) {
  if (hasActiveLiveMessage()) return;
  await sendHTML(
`⚠️ <b>Out of Range</b>: ${escHtml(pair)}
Been OOR for ${fmtAge(minutesOOR)}`
  );
}

export async function notifyHighConviction({ pair, ageHours, score, organic, feeTvlRatio, amountSol, hcTier = 1, tierWindow = null }) {
  if (hasActiveLiveMessage()) return;
  const now = new Date();
  const tierLabel = hcTier === 2 ? "HC OVERRIDE T2" : "HC OVERRIDE T1";
  const windowStr = tierWindow ?? (hcTier === 2 ? "48-72h" : "24-48h");
  const ageStr = ageHours != null ? `${ageHours.toFixed(1)}h (${windowStr} window)` : "?";
  await sendHTML(
`╔═══════════════════════╗
║  ⚡ ${tierLabel.padEnd(16)}║
╚═══════════════════════╝
🪙 Pool     ${escHtml(pair)}
⏱️ Age      ${ageStr}
⭐ Score    ${score != null ? score.toFixed(1) + "/5" : "?"}
🎯 Organic  ${organic != null ? organic + "%" : "?"}
💵 Amount   ${amountSol} SOL
⚠️ Young pool — monitoring closely
${SEP}`
  );
}

// ─── Structured cycle formatters (called from index.js) ──────────

export function buildManagementCycleHtml({ positionData = [], actionMap = new Map(), noAction = false }) {
  const timeStr = fmtUtcTime();
  const headerLine = noAction ? `⏰ ${timeStr} — All Clear ✅` : `⏰ ${timeStr}`;

  const posBlocks = positionData.map(p => {
    const act = (actionMap instanceof Map ? actionMap.get(p.position) : null) ?? { action: "STAY" };
    const decision = (() => {
      if (act.action === "STAY") return "STAY";
      if (act.action === "CLAIM") return "CLAIM FEES";
      if (act.action === "CLOSE") return `CLOSE${act.reason ? ` — ${String(act.reason).replace(/\[SAFETY\]\s*/i, "").slice(0, 28)}` : ""}`;
      if (act.action === "INSTRUCTION") return "EVAL (instruction)";
      return act.action;
    })();
    const statusLabel = p.in_range ? "🟢 IN RANGE" : `🔴 OOR ${fmtAge(p.minutes_out_of_range)}`;
    const pnlPct = Number(p.pnl_pct) || 0;
    // pnl_usd and value fields already in SOL when solMode=true
    const pnlSol = Number(p.pnl_usd) || 0;
    const pnlLine = `${fmtSolPnl(pnlSol, pnlPct)} ${pnlPct >= 0 ? "✅" : "🔴"}`;
    const yieldRaw = Number(p.fee_per_tvl_24h);
    const yieldStr = p.fee_per_tvl_24h != null
      ? `${yieldRaw < 0.1 && yieldRaw > 0 ? yieldRaw.toFixed(4) : yieldRaw.toFixed(2)}% APR`
      : "—";
    return [
      `🪙 ${escHtml(p.pair)}`,
      `├ 💵 Value      ${fmtSol(p.total_value_usd || 0)}`,
      `├ 💎 Unclaimed  ${fmtSol(p.unclaimed_fees_usd || 0)}`,
      `├ 📈 PnL        ${pnlLine}`,
      `├ 🌾 Yield      ${yieldStr}`,
      `├ ⏱️ Age        ${fmtAge(p.age_minutes)}`,
      `├ 📍 Status     ${statusLabel}`,
      `└ 👉 Decision   ${escHtml(decision)}`,
    ].join("\n");
  });

  const totalValue = positionData.reduce((s, p) => s + (Number(p.total_value_usd) || 0), 0);
  const totalFees  = positionData.reduce((s, p) => s + (Number(p.unclaimed_fees_usd) || 0), 0);
  const avgPnl = positionData.length > 0
    ? positionData.reduce((s, p) => s + (Number(p.pnl_pct) || 0), 0) / positionData.length
    : 0;

  const summaryLines = noAction
    ? [
        "━━━ 💼 PORTFOLIO ━━━",
        `💵 Total Value  ${fmtSol(totalValue)}`,
        `💎 Total Fees   ${fmtSol(totalFees)}`,
        `📈 Combined PnL ${avgPnl >= 0 ? "+" : ""}${avgPnl.toFixed(2)}%`,
      ]
    : [
        "━━━ 📊 SUMMARY ━━━",
        `📂 Positions    ${positionData.length} open`,
        `💵 Total Value  ${fmtSol(totalValue)}`,
        `💎 Total Fees   ${fmtSol(totalFees)}`,
        `⚡ Action       ${positionData.some(p => (actionMap instanceof Map ? actionMap.get(p.position)?.action : null) !== "STAY") ? "Actions taken" : "No changes"}`,
      ];

  return [
    "╔═══════════════════════╗",
    "║  🔄 MANAGEMENT CYCLE  ║",
    "╚═══════════════════════╝",
    headerLine,
    "",
    noAction ? "━━━ 📂 POSITIONS ━━━" : "━━━ 📂 OPEN POSITIONS ━━━",
    ...posBlocks.flatMap((b, i) => i === 0 ? [b] : ["", b]),
    "",
    ...summaryLines,
    SEP,
  ].join("\n");
}

export function buildScreeningCycleHtml({ content = "", btcCheck = null, walletSol = null, deployAmount = null, deployMeta = null }) {
  const timeStr = fmtUtcTime();
  const btcLabel = btcCheck?.downtrend
    ? `⚠️  ${btcCheck.btc_change_4h != null ? btcCheck.btc_change_4h.toFixed(1) + "% 4h" : "Downtrend"}`
    : "✅ Neutral";
  const isHighConviction = /HIGH CONVICTION/i.test(content);
  const analysisHeader = isHighConviction ? "━━━ ⚡ AI ANALYSIS ━━━" : "━━━ 🤖 AI ANALYSIS ━━━";

  let rrLine = null;
  let strategyLine = null;
  let priceLine = null;
  if (deployMeta) {
    if (deployMeta.rrExpected != null) {
      const rrPass = deployMeta.rrExpected >= 4;
      rrLine = `⚖️ R:R           ${deployMeta.rrExpected}% expected / ${deployMeta.rrRisk}% risk ${rrPass ? "✅" : "❌"}`;
    }
    if (deployMeta.strategyLabel != null) {
      const strategyDisplay = deployMeta.strategyLabel.includes("bid_ask") || deployMeta.strategyLabel.toLowerCase().includes("bid-ask")
        ? "BID-ASK (balanced)"
        : deployMeta.strategyLabel.toLowerCase().includes("spot")
          ? "SPOT (SOL-only)"
          : deployMeta.strategyLabel;
      strategyLine = `📊 Strategy      ${strategyDisplay}`;
    }
    if (deployMeta.pricePct != null) {
      const centered = deployMeta.pricePct >= 25 && deployMeta.pricePct <= 75;
      priceLine = `📍 Price pos     ${deployMeta.pricePct}th percentile ${centered ? "✅" : "⚠️"}`;
    }
  }

  const parts = [
    "╔═══════════════════════╗",
    "║   🔍 SCREENING CYCLE  ║",
    "╚═══════════════════════╝",
    `⏰ ${timeStr}`,
    "",
    `${btcCheck?.downtrend ? "⚠️" : "✅"} BTC Trend    ${btcLabel}`,
    walletSol  != null ? `✅ Wallet       ${Number(walletSol).toFixed(3)} SOL`  : null,
    deployAmount != null ? `📊 Deploy       ${deployAmount} SOL`                : null,
    rrLine,
    strategyLine,
    priceLine,
    "",
    analysisHeader,
    escHtml(content || "No report"),
    SEP,
  ].filter(v => v !== null);
  return parts.join("\n");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
