import fs from "fs";
import { log } from "./logger.js";
import { getPerformanceSummary } from "./lessons.js";
import { getCachedSolPrice } from "./config.js";

const STATE_FILE = "./state.json";
const LESSONS_FILE = "./lessons.json";

export async function generateBriefing() {
  const state = loadJson(STATE_FILE) || { positions: {}, recentEvents: [] };
  const lessonsData = loadJson(LESSONS_FILE) || { lessons: [], performance: [] };

  const now = new Date();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  // 1. Positions Activity
  const allPositions = Object.values(state.positions || {});
  const openedLast24h = allPositions.filter(p => new Date(p.deployed_at) > last24h);
  const closedLast24h = allPositions.filter(p => p.closed && new Date(p.closed_at) > last24h);

  // 2. Performance Activity (from performance log)
  const perfLast24h = (lessonsData.performance || []).filter(p => new Date(p.recorded_at) > last24h);
  const totalPnLUsd = perfLast24h.reduce((sum, p) => sum + (p.pnl_usd || 0), 0);
  const totalFeesUsd = perfLast24h.reduce((sum, p) => sum + (p.fees_earned_usd || 0), 0);

  // 3. Lessons Learned
  const lessonsLast24h = (lessonsData.lessons || []).filter(l => new Date(l.created_at) > last24h);

  // 4. Current State
  const openPositions = allPositions.filter(p => !p.closed);
  const perfSummary = getPerformanceSummary();

  // 5. Format Message
  const solPrice = getCachedSolPrice();
  const totalPnLSol = solPrice > 0 ? totalPnLUsd / solPrice : 0;
  const totalFeesSol = solPrice > 0 ? totalFeesUsd / solPrice : 0;

  const dateStr = now.toLocaleDateString("en-US", {
    day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
  });
  const pnlSign = totalPnLSol >= 0 ? "+" : "";
  const pnlEmoji = totalPnLSol >= 0 ? "✅" : "🔴";
  const winCount = perfLast24h.filter(p => (p.pnl_usd || 0) > 0).length;
  const lossCount = perfLast24h.filter(p => (p.pnl_usd || 0) < 0).length;
  const winRateStr = perfLast24h.length > 0
    ? `${Math.round((winCount / perfLast24h.length) * 100)}% (${winCount}W/${lossCount}L)`
    : "N/A";

  const latestLesson = lessonsLast24h.length > 0
    ? lessonsLast24h[lessonsLast24h.length - 1].rule.slice(0, 120)
    : "No new lessons recorded overnight.";

  const allTimeSol = perfSummary && solPrice > 0 ? perfSummary.total_pnl_usd / solPrice : null;
  const allTimePnlStr = allTimeSol != null
    ? `${allTimeSol >= 0 ? "+" : ""}${Math.abs(allTimeSol).toFixed(4)} SOL`
    : "N/A";

  const lines = [
    "╔═══════════════════════╗",
    "║   ☀️ MERIDIAN DAILY   ║",
    "╚═══════════════════════╝",
    `📅 ${dateStr}`,
    "",
    "━━━ 📊 PERFORMANCE ━━━",
    `💰 Net PnL      ${pnlSign}${Math.abs(totalPnLSol).toFixed(4)} SOL ${pnlEmoji}`,
    `💎 Fees Earned  ${totalFeesSol.toFixed(4)} SOL`,
    `🎯 Win Rate     ${winRateStr}`,
    `📥 Opened       ${openedLast24h.length} position${openedLast24h.length !== 1 ? "s" : ""}`,
    `📤 Closed       ${closedLast24h.length} position${closedLast24h.length !== 1 ? "s" : ""}`,
    "",
    "━━━ 🧠 LESSON LEARNED ━━━",
    latestLesson,
    "",
    "━━━ 💼 PORTFOLIO ━━━",
    `📂 Open Now     ${openPositions.length} position${openPositions.length !== 1 ? "s" : ""}`,
    `📈 All-time PnL ${allTimePnlStr}`,
    "━━━━━━━━━━━━━━━━━━━━━━━",
  ];

  return lines.join("\n");
}

function loadJson(file) {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    log("briefing_error", `Failed to read ${file}: ${err.message}`);
    return null;
  }
}
