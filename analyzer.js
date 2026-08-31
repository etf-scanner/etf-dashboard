/**
 * leveraged-etf-analyzer.js
 *
 * Analyzes high-volume leveraged ETFs listed on NYSE Arca (NYSEARCA) by
 * reading TREND from the UNDERLYING INDEX (e.g. QQQ for TQQQ/SQQQ), then
 * applies that signal to the leveraged product itself for entry/exit and
 * stop-loss sizing.
 *
 * WHY THE UNDERLYING: leveraged ETFs rebalance daily, which adds noise and
 * decay to their own price action. The underlying index gives a cleaner
 * read on the actual trend; the leveraged ETF's own price/volume/ATR are
 * still used for execution (price levels, stops, liquidity confirmation).
 *
 * REAL DATA: this pulls live daily OHLCV bars from Yahoo Finance's public
 * chart endpoint (query1.finance.yahoo.com) — no API key required, and no
 * mock/sample data anywhere in this script. It is an unofficial endpoint,
 * so it can occasionally rate-limit or change shape. If you want a
 * contractually-supported feed, swap fetchDailyBars() for a paid provider
 * (Polygon.io, Alpaca, IEX Cloud, Alpha Vantage) — the rest of the script
 * (indicators, signal logic) works unchanged as long as you return bars in
 * the same { date, open, high, low, close, volume } shape.
 *
 * IMPORTANT: This is a technical-analysis tool, not financial advice.
 * Always confirm signals with your own risk management rules.
 *
 * Requires Node.js 18+ (built-in fetch). No dependencies.
 *
 * Usage:
 *   node leveraged-etf-analyzer.js
 *   node leveraged-etf-analyzer.js TQQQ SOXL FAS
 */

// ---------------------------------------------------------------------------
// 1. Universe: leveraged ETF -> underlying index/ETF it tracks
// ---------------------------------------------------------------------------
const ETF_MAP = {
  TQQQ: { underlying: "QQQ", leverage: 3, name: "Nasdaq-100 3x Bull" },
  SQQQ: { underlying: "QQQ", leverage: -3, name: "Nasdaq-100 3x Bear" },
  SPXL: { underlying: "SPY", leverage: 3, name: "S&P 500 3x Bull" },
  SPXS: { underlying: "SPY", leverage: -3, name: "S&P 500 3x Bear" },
  UPRO: { underlying: "SPY", leverage: 3, name: "S&P 500 3x Bull" },
  SPXU: { underlying: "SPY", leverage: -3, name: "S&P 500 3x Bear" },
  SOXL: { underlying: "SOXX", leverage: 3, name: "Semiconductors 3x Bull" },
  SOXS: { underlying: "SOXX", leverage: -3, name: "Semiconductors 3x Bear" },
  TNA: { underlying: "IWM", leverage: 3, name: "Russell 2000 3x Bull" },
  TZA: { underlying: "IWM", leverage: -3, name: "Russell 2000 3x Bear" },
  FAS: { underlying: "XLF", leverage: 3, name: "Financials 3x Bull" },
  FAZ: { underlying: "XLF", leverage: -3, name: "Financials 3x Bear" },
  LABU: { underlying: "XBI", leverage: 3, name: "Biotech 3x Bull" },
  LABD: { underlying: "XBI", leverage: -3, name: "Biotech 3x Bear" },
  TECL: { underlying: "XLK", leverage: 3, name: "Technology 3x Bull" },
  TECS: { underlying: "XLK", leverage: -3, name: "Technology 3x Bear" },
  TMF: { underlying: "TLT", leverage: 3, name: "20+ Yr Treasury 3x Bull" },
  FNGU: { underlying: "FNGS", leverage: 3, name: "FANG+ 3x Bull" },
};

const DEFAULT_UNIVERSE = Object.keys(ETF_MAP);

// ---------------------------------------------------------------------------
// 2. Data fetching — Yahoo Finance public chart endpoint (real market data)
// ---------------------------------------------------------------------------
async function fetchDailyBars(symbol, range = "max", retries = 2) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=${range}&interval=1d`;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();

      const result = json?.chart?.result?.[0];
      if (!result) throw new Error(json?.chart?.error?.description || "no data");

      const timestamps = result.timestamp;
      const quote = result.indicators.quote[0];

      const bars = timestamps
        .map((t, i) => ({
          date: new Date(t * 1000).toISOString().slice(0, 10),
          open: quote.open[i],
          high: quote.high[i],
          low: quote.low[i],
          // Use raw close (not split-adjusted) so open/high/low/close stay
          // internally consistent. Mixing adjusted close with unadjusted
          // high/low caused a massive scale mismatch on symbols with reverse
          // splits (common for leveraged/inverse ETFs), which blew up ATR
          // and produced nonsense stop-loss/take-profit levels.
          close: quote.close[i],
          volume: quote.volume[i],
        }))
        .filter((b) => b.close != null && b.high != null && b.low != null && b.open != null)
        // Hard sanity check: a bar's close (and open) must fall within its own
        // high/low — if not, that's corrupted data (a known issue with free
        // historical feeds, especially for thinly-tracked, heavily
        // reverse-split ETPs). One bad tick like this can blow up ATR for a
        // long time afterward via its smoothing, so we drop it outright
        // rather than let a single garbage row poison the whole calculation.
        .filter(
          (b) =>
            b.high >= b.low &&
            b.close <= b.high * 1.01 &&
            b.close >= b.low * 0.99 &&
            b.open <= b.high * 1.01 &&
            b.open >= b.low * 0.99
        );

      if (bars.length === 0) throw new Error("empty bar set");
      return bars;
    } catch (err) {
      if (attempt === retries) {
        throw new Error(`Failed to fetch real data for ${symbol}: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1))); // backoff
    }
  }
}

// ---------------------------------------------------------------------------
// 3. Indicators
// ---------------------------------------------------------------------------
function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) continue;
    prev = prev == null ? values[i] : values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = null, avgLoss = null, gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      gains += gain;
      losses += loss;
      if (i === period) {
        avgGain = gains / period;
        avgLoss = losses / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
      continue;
    }
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function atr(bars, period = 14) {
  const trs = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose)
    );
  });
  return ema(trs, period);
}

// Simplified Wilder ADX (trend strength, 0-100). >25 = trending, <20 = choppy.
function adx(bars, period = 14) {
  const plusDM = [0], minusDM = [0], trArr = [bars[0].high - bars[0].low];

  for (let i = 1; i < bars.length; i++) {
    const upMove = bars[i].high - bars[i - 1].high;
    const downMove = bars[i - 1].low - bars[i].low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trArr.push(
      Math.max(
        bars[i].high - bars[i].low,
        Math.abs(bars[i].high - bars[i - 1].close),
        Math.abs(bars[i].low - bars[i - 1].close)
      )
    );
  }

  const smoothedTR = ema(trArr, period);
  const smoothedPlusDM = ema(plusDM, period);
  const smoothedMinusDM = ema(minusDM, period);

  const plusDI = smoothedPlusDM.map((v, i) =>
    v != null && smoothedTR[i] ? (100 * v) / smoothedTR[i] : null
  );
  const minusDI = smoothedMinusDM.map((v, i) =>
    v != null && smoothedTR[i] ? (100 * v) / smoothedTR[i] : null
  );
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p == null || m == null || p + m === 0) return null;
    return (100 * Math.abs(p - m)) / (p + m);
  });

  const cleanDx = dx.map((v) => (v == null ? 0 : v));
  return { adx: ema(cleanDx, period), plusDI, minusDI };
}

// ---------------------------------------------------------------------------
// 4. Trend read from the UNDERLYING index
// ---------------------------------------------------------------------------
function readUnderlyingTrend(bars) {
  const closes = bars.map((b) => b.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const { adx: adxLine } = adx(bars, 14);

  const last = bars.length - 1;
  const trendUp = ema20[last] > ema50[last];
  const strength = adxLine[last] ?? 0;
  const momentum = rsi14[last];
  const extension = ((closes[last] - ema50[last]) / ema50[last]) * 100;

  return {
    direction: trendUp ? "UP" : "DOWN",
    isTrending: strength > 25,
    strength,
    rsi: momentum,
    extensionPct: extension,
    price: closes[last],
  };
}

// ---------------------------------------------------------------------------
// 5. Combine underlying trend + leveraged ETF execution data into a signal
// ---------------------------------------------------------------------------
function buildSignal(etfSymbol, meta, underlyingTrend, etfBars) {
  const closes = etfBars.map((b) => b.close);
  const volumes = etfBars.map((b) => b.volume);
  const last = etfBars.length - 1;

  const etfPrice = closes[last];
  const etfATR = atr(etfBars, 14)[last];
  const volSMA20 = sma(volumes, 20)[last];
  const volToday = volumes[last];
  const liquid = volToday > volSMA20 * 0.8; // avoid trading into a dead tape

  const wantsUp = meta.leverage > 0;
  const trendFavorsThisEtf =
    (wantsUp && underlyingTrend.direction === "UP") ||
    (!wantsUp && underlyingTrend.direction === "DOWN");

  let signal = "STAY OUT";
  const reasons = [];

  if (!underlyingTrend.isTrending) {
    signal = "STAY OUT — underlying is range-bound (ADX < 25)";
    reasons.push(
      `${meta.underlying} ADX ${underlyingTrend.strength.toFixed(1)}: no reliable trend`
    );
    reasons.push("Chop is where leveraged ETFs decay fastest — avoid holding here");
  } else if (trendFavorsThisEtf) {
    const rsiExtreme = wantsUp ? underlyingTrend.rsi >= 70 : underlyingTrend.rsi <= 30;
    if (rsiExtreme) {
      signal = "CAUTION — trend confirmed but underlying is extended";
      reasons.push(
        `${meta.underlying} RSI ${underlyingTrend.rsi.toFixed(1)} at an extreme — pullback risk`
      );
    } else if (!liquid) {
      signal = `TREND CONFIRMED — but ${etfSymbol} volume is thin today, size down`;
      reasons.push(`${etfSymbol} volume below 80% of its 20-day average`);
    } else {
      signal = `ENTRY — ${meta.name}`;
      reasons.push(
        `${meta.underlying} trending ${underlyingTrend.direction}, ADX ${underlyingTrend.strength.toFixed(
          1
        )} confirms strength`
      );
      reasons.push(`${meta.underlying} RSI ${underlyingTrend.rsi.toFixed(1)} — room left before extreme`);
      reasons.push(`${etfSymbol} volume confirms liquidity`);
    }
  } else {
    signal = "AVOID / EXIT — underlying trend runs against this ETF";
    reasons.push(
      `${meta.underlying} is trending ${underlyingTrend.direction}, which works against ${etfSymbol}`
    );
    reasons.push(`Consider the opposite leg instead if you want exposure to this trend`);
  }

  const isBuy = signal.startsWith("ENTRY");
  const stopDistance = etfATR * 2; // 2x ATR default stop
  const targetDistance = etfATR * 3; // 3x ATR target -> 1.5:1 reward:risk
  // Every entry here is BUY / LONG the ETF itself (bull ETF for bullish exposure,
  // bear/inverse ETF for bearish exposure) — this strategy never shorts the ETF.
  // Stop-loss/take-profit only mean something if you're actually entering a
  // trade, so leave them null on anything other than an active BUY signal.
  const stopLoss = isBuy ? (etfPrice - stopDistance).toFixed(2) : null;
  const takeProfit = isBuy ? (etfPrice + targetDistance).toFixed(2) : null;
  const stopLossPct = isBuy ? (((etfPrice - stopDistance) - etfPrice) / etfPrice * 100).toFixed(1) : null;
  const takeProfitPct = isBuy ? (((etfPrice + targetDistance) - etfPrice) / etfPrice * 100).toFixed(1) : null;
  const action = signal.startsWith("ENTRY")
    ? `BUY / LONG ${etfSymbol}`
    : signal.startsWith("CAUTION") || signal.startsWith("TREND CONFIRMED")
    ? `HOLD OFF — do not buy ${etfSymbol} yet`
    : `DO NOT BUY ${etfSymbol}`;

  return {
    symbol: etfSymbol,
    name: meta.name,
    underlying: meta.underlying,
    etfPrice: etfPrice.toFixed(2),
    underlyingTrend: underlyingTrend.direction,
    underlyingAdx: underlyingTrend.strength.toFixed(1),
    underlyingRsi: underlyingTrend.rsi.toFixed(1),
    underlyingExtensionPct: underlyingTrend.extensionPct.toFixed(2),
    etfAtr: etfATR.toFixed(2),
    etfVolumeVsAvg: `${((volToday / volSMA20) * 100).toFixed(0)}%`,
    signal,
    action,
    reasons,
    stopLoss,
    takeProfit,
    stopLossPct,
    takeProfitPct,
    // filled in by the runner after backtest() runs:
    winRate: null,
    rewardRisk: null,
    numTrades: null,
  };
}

// ---------------------------------------------------------------------------
// 6. Backtest — replays the same entry/exit rules over history using REAL
//    underlying trend data + REAL leveraged-ETF prices for P&L.
// ---------------------------------------------------------------------------
function backtest(meta, underlyingBars, etfBars) {
  const closes = underlyingBars.map((b) => b.close);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const { adx: adxLine } = adx(underlyingBars, 14);
  const etfAtr14 = atr(etfBars, 14);

  const etfDateIdx = new Map(etfBars.map((b, i) => [b.date, i]));
  const wantsUp = meta.leverage > 0;

  const trades = [];
  let inTrade = false;
  let entryPrice = null;
  let stopPrice = null;
  let targetPrice = null;

  for (let i = 50; i < underlyingBars.length; i++) {
    if (ema20[i] == null || ema50[i] == null || adxLine[i] == null || rsi14[i] == null) continue;

    const direction = ema20[i] > ema50[i] ? "UP" : "DOWN";
    const isTrending = adxLine[i] > 25;
    const favors = (wantsUp && direction === "UP") || (!wantsUp && direction === "DOWN");
    const rsiExtreme = wantsUp ? rsi14[i] >= 70 : rsi14[i] <= 30;
    const etfIdx = etfDateIdx.get(underlyingBars[i].date);
    if (etfIdx == null) continue;
    const bar = etfBars[etfIdx];

    if (!inTrade) {
      if (isTrending && favors && !rsiExtreme) {
        inTrade = true;
        entryPrice = bar.close;
        const atrAtEntry = etfAtr14[etfIdx] || 0.01;
        stopPrice = entryPrice - 2 * atrAtEntry; // matches the live 2x ATR stop
        targetPrice = entryPrice + 3 * atrAtEntry; // matches the live 3x ATR target
      }
      continue;
    }

    // In a trade: check whether that day's real high/low actually touched the
    // stop or target BEFORE falling back to a trend-reversal exit. This is
    // what makes the backtest match the stop-loss/take-profit shown live —
    // earlier versions ignored these levels entirely and only used trend exits.
    const riskUnit = entryPrice - stopPrice; // = 2x ATR at entry
    const hitStop = bar.low <= stopPrice;
    const hitTarget = bar.high >= targetPrice;

    if (hitStop && hitTarget) {
      // Both touched same day — can't know which came first without intraday
      // data, so conservatively assume the stop hit first (avoids overstating
      // performance).
      trades.push({ reward: stopPrice - entryPrice, r: -1 });
      inTrade = false;
    } else if (hitStop) {
      trades.push({ reward: stopPrice - entryPrice, r: -1 });
      inTrade = false;
    } else if (hitTarget) {
      trades.push({ reward: targetPrice - entryPrice, r: 1.5 });
      inTrade = false;
    } else if (!isTrending || direction !== (wantsUp ? "UP" : "DOWN")) {
      const exitPrice = bar.close;
      const reward = exitPrice - entryPrice;
      trades.push({ reward, r: reward / riskUnit });
      inTrade = false;
    }
  }

  if (trades.length === 0) {
    return { numTrades: 0, winRate: null, rewardRisk: null };
  }

  const wins = trades.filter((t) => t.reward > 0);
  const losses = trades.filter((t) => t.reward <= 0);
  const winRate = (wins.length / trades.length) * 100;
  const avgWinR = wins.length ? wins.reduce((s, t) => s + t.r, 0) / wins.length : 0;
  const avgLossR = losses.length ? Math.abs(losses.reduce((s, t) => s + t.r, 0) / losses.length) : 0;
  const rewardRisk = avgLossR > 0 ? avgWinR / avgLossR : null;

  return { numTrades: trades.length, winRate, rewardRisk };
}

// ---------------------------------------------------------------------------
// 7. Runner
// ---------------------------------------------------------------------------
async function run(symbols) {
  const validSymbols = symbols.filter((s) => {
    if (!ETF_MAP[s]) {
      console.log(`Skipping ${s}: not in ETF_MAP (add it if you want it covered)`);
      return false;
    }
    return true;
  });

  console.log(`\nFetching real market data for ${validSymbols.length} ETFs + their underlyings...\n`);

  // Cache underlying fetches so we don't re-fetch QQQ four times etc.
  const underlyingCache = new Map();
  const results = [];

  for (const symbol of validSymbols) {
    const meta = ETF_MAP[symbol];
    try {
      if (!underlyingCache.has(meta.underlying)) {
        const bars = await fetchDailyBars(meta.underlying, "max");
        underlyingCache.set(meta.underlying, bars);
      }
      const underlyingBars = underlyingCache.get(meta.underlying);
      if (underlyingBars.length < 60) {
        console.log(`${meta.underlying}: not enough history, skipping ${symbol}`);
        continue;
      }
      const underlyingTrend = readUnderlyingTrend(underlyingBars);

      const etfBars = await fetchDailyBars(symbol, "max");
      if (etfBars.length < 30) {
        console.log(`${symbol}: not enough history, skipping`);
        continue;
      }

      const signalResult = buildSignal(symbol, meta, underlyingTrend, etfBars);
      const bt = backtest(meta, underlyingBars, etfBars);
      signalResult.numTrades = bt.numTrades;
      signalResult.winRate = bt.winRate == null ? null : Number(bt.winRate.toFixed(1));
      signalResult.rewardRisk = bt.rewardRisk == null ? null : Number(bt.rewardRisk.toFixed(2));

      results.push(signalResult);
    } catch (err) {
      console.log(`${symbol}: ${err.message}`);
    }
  }

  results.sort((a, b) => {
    const score = (r) => (r.signal.startsWith("ENTRY") ? 2 : r.signal.startsWith("CAUTION") ? 1 : 0);
    return score(b) - score(a) || parseFloat(b.underlyingAdx) - parseFloat(a.underlyingAdx);
  });

  for (const r of results) {
    console.log("─".repeat(70));
    console.log(`${r.symbol} (${r.name})  |  tracks ${r.underlying}  |  $${r.etfPrice}`);
    console.log(
      `${r.underlying} trend: ${r.underlyingTrend}  ADX: ${r.underlyingAdx}  RSI: ${r.underlyingRsi}  ext: ${r.underlyingExtensionPct}%`
    );
    console.log(`${r.symbol} ATR: ${r.etfAtr}   Vol vs 20d avg: ${r.etfVolumeVsAvg}`);
    console.log(`SIGNAL: ${r.signal}`);
    console.log(`ACTION: ${r.action}`);
    r.reasons.forEach((line) => console.log(`  - ${line}`));
    if (r.stopLoss != null) {
      console.log(
        `Suggested stop-loss: $${r.stopLoss} (${r.stopLossPct}%)   take-profit: $${r.takeProfit} (+${r.takeProfitPct}%)`
      );
    }
    console.log(
      `Backtest (full history): win rate ${r.winRate == null ? "n/a" : r.winRate + "%"}   ` +
        `reward/risk ${r.rewardRisk == null ? "n/a" : r.rewardRisk}   ` +
        `trades ${r.numTrades}`
    );
  }
  console.log("─".repeat(70));
  console.log(
    "\nData source: Yahoo Finance public chart API (live daily bars, unofficial endpoint).\n" +
      "Backtest replays the same entry/exit rules over the full available REAL price history for each symbol (as far back as Yahoo has it — often 10-15+ years for older ETFs).\n" +
      "Reminder: leveraged ETFs are built for short-term tactical trades, not buy-and-hold.\n" +
      "This is a technical framework, not financial advice — confirm with your own risk rules.\n"
  );

  const fs = await import("fs");
  fs.writeFileSync("docs/results.json", JSON.stringify(results, null, 2));
  console.log("Wrote docs/results.json\n");
}

const symbols = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_UNIVERSE;
run(symbols);
