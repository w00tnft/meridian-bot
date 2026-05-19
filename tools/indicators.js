/**
 * Technical indicator calculations for dump catch mode.
 * Uses OKX 15-min OHLCV candles. Candle format: { open, high, low, close, volume, timestamp }
 */

const OKX_SPOT_BASE = "https://www.okx.com";

// ─── Supertrend (period=10, multiplier=3) ───────────────────────────────────

export function calculateSupertrend(candles, period = 10, multiplier = 3) {
  if (candles.length < period + 1) return null;

  // True Range
  const tr = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });

  // ATR (Simple Moving Average of TR)
  const atr = [];
  for (let i = 0; i < candles.length; i++) {
    if (i < period - 1) { atr.push(null); continue; }
    const avg = tr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0) / period;
    atr.push(avg);
  }

  const supertrend = [];
  const trend = [];
  const upperBand = [];
  const lowerBand = [];

  for (let i = 0; i < candles.length; i++) {
    if (atr[i] === null) {
      supertrend.push(null); trend.push(null);
      upperBand.push(null); lowerBand.push(null);
      continue;
    }
    const hl2 = (candles[i].high + candles[i].low) / 2;
    const basicUpper = hl2 + multiplier * atr[i];
    const basicLower = hl2 - multiplier * atr[i];

    const prevUpper = upperBand[i - 1] ?? basicUpper;
    const prevLower = lowerBand[i - 1] ?? basicLower;
    const prevClose = candles[i - 1]?.close ?? candles[i].close;

    const finalUpper = basicUpper < prevUpper || prevClose > prevUpper ? basicUpper : prevUpper;
    const finalLower = basicLower > prevLower || prevClose < prevLower ? basicLower : prevLower;
    upperBand.push(finalUpper);
    lowerBand.push(finalLower);

    const prevTrend = trend[i - 1] ?? 1;
    let currentTrend;
    if (prevTrend === -1 && candles[i].close > finalUpper) currentTrend = 1;
    else if (prevTrend === 1 && candles[i].close < finalLower) currentTrend = -1;
    else currentTrend = prevTrend;

    trend.push(currentTrend);
    supertrend.push(currentTrend === 1 ? finalLower : finalUpper);
  }

  const last = candles.length - 1;
  const prev = candles.length - 2;

  let candlesSinceFlip = 0;
  for (let i = last; i >= 0; i--) {
    if (trend[i] === trend[last]) candlesSinceFlip++;
    else break;
  }

  return {
    value: supertrend[last],
    trend: trend[last] === 1 ? "bullish" : "bearish",
    recentFlip: trend[last] === 1 && trend[prev] === -1,
    candlesSinceFlip,
  };
}

// ─── RSI (Evil Panda uses period=2, overbought at 90) ───────────────────────

export function calculateRSI(candles, period = 2) {
  if (candles.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = candles[candles.length - period - 1 + i].close -
                 candles[candles.length - period - 1 + i - 1].close;
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const rsi = 100 - (100 / (1 + rs));
  return {
    value: rsi,
    overbought: rsi > 90,
  };
}

// ─── MACD (12, 26, 9) ───────────────────────────────────────────────────────

export function calculateMACD(candles, fast = 12, slow = 26, signal = 9) {
  if (candles.length < slow + signal) return null;

  const ema = (data, p) => {
    const k = 2 / (p + 1);
    let v = data[0];
    for (let i = 1; i < data.length; i++) v = data[i] * k + v * (1 - k);
    return v;
  };

  const closes = candles.map(c => c.close);
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const fastEma = ema(closes.slice(i - fast + 1, i + 1), fast);
    const slowEma = ema(closes.slice(i - slow + 1, i + 1), slow);
    macdLine.push(fastEma - slowEma);
  }

  const signalLine = ema(macdLine, signal);
  const currentHistogram = macdLine[macdLine.length - 1] - signalLine;
  const prevHistogram = macdLine[macdLine.length - 2] - signalLine;

  return {
    histogram: currentHistogram,
    firstGreenBar: currentHistogram > 0 && prevHistogram <= 0,
  };
}

// ─── Fib levels from ATH ────────────────────────────────────────────────────

export function calculateFibLevels(athPrice) {
  return {
    level_100bins: athPrice * 0.51,  // -49% from ATH → 100 bins
    level_125bins: athPrice * 0.43,  // -57% from ATH → 125 bins
    level_200bins: athPrice * 0.27,  // -73% from ATH → 200 bins
    level_250bins: athPrice * 0.19,  // -81% from ATH → 250 bins
  };
}

// ─── Bin selection based on Supertrend vs Fib levels ───────────────────────

export function selectBinsBySupertrendPosition(supertrendValue, fibLevels) {
  if (supertrendValue > fibLevels.level_100bins) return { bins: 100, rangeDesc: "-49% (100 bins)" };
  if (supertrendValue > fibLevels.level_125bins) return { bins: 125, rangeDesc: "-57% (125 bins)" };
  if (supertrendValue > fibLevels.level_200bins) return { bins: 200, rangeDesc: "-73% (200 bins)" };
  return { bins: 250, rangeDesc: "-81% (250 bins)" };
}

// ─── Fetch 15m candles from OKX spot ────────────────────────────────────────

export async function fetch15mCandles(tokenSymbol, limit = 100) {
  if (!tokenSymbol) return null;
  const symbol = String(tokenSymbol).toUpperCase().replace(/[-/]SOL$/i, "").replace(/[-/]USDT$/i, "");
  const instId = `${symbol}-USDT`;
  try {
    const url = `${OKX_SPOT_BASE}/api/v5/market/candles?instId=${encodeURIComponent(instId)}&bar=15m&limit=${limit}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    if (json.code !== "0" || !Array.isArray(json.data) || json.data.length === 0) return null;
    // OKX returns newest first — reverse for chronological order
    return json.data.reverse().map(c => ({
      timestamp: Number(c[0]),
      open:   parseFloat(c[1]),
      high:   parseFloat(c[2]),
      low:    parseFloat(c[3]),
      close:  parseFloat(c[4]),
      volume: parseFloat(c[5]),
    }));
  } catch {
    return null;
  }
}
