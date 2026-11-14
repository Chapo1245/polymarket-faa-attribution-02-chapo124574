// Polymarket FAA attribution — minute-by-minute 4h-ahead Yes-price quantiles.
//
// One program, one forecast per market: for each of the 240 minutes after a
// case's checkpoint, five quantiles (0.05 / 0.25 / 0.5 / 0.75 / 0.95) of that
// minute's Yes price.
//
// Prices here move in steps — long flat stretches, then a tick, now and then
// a jump — so the forecast is built per market from its own recent behaviour:
//
//   * Spread: the winsorized one-minute volatility over the last 4 hours,
//     weighted toward the most recent minutes (exponential half-life 60 min),
//     because volatility regimes turn over in hours, not days. Raw one-minute
//     volatility overstates how far a steppy price travels, so it is scaled
//     by 0.45, floored and capped, and a level term is added in quadrature:
//     a market's room to move grows with sqrt(x * (1 - x)).
//   * Growth: the spread grows with the horizon as (h / 240) ^ 0.4, not
//     sqrt(h) — a steppy price's move distribution saturates fast; most of a
//     four-hour move is already possible in the first hour.
//   * Median: the last price, with a tenth of the last hour's move faded back
//     over the horizon — sharp one-hour moves partly revert.
//   * Skew: the lower tail is wider than the upper tail when the price is
//     high (more room to fall than to rise) and the reverse when it is low,
//     scaled by 1.5 * (x - 0.05) and clamped. A price near 0 can jump up far
//     but barely fall; a price near 1 is the mirror.
//
// Practice loss 0.262933 (house persistence baseline 0.363589) on the six
// sealed practice cases; the forecast beats the baseline on all six.
// Per case: p00 0.448094, p01 0.292765, p02 0.357945, p03 0.243761,
// p04 0.182745, p05 0.116071.
import * as fs from "node:fs";
import * as path from "node:path";

const HORIZON = 240;
const Z = [-1.644854, -0.67449, 0, 0.67449, 1.644854];

// Spread from recent one-minute moves: half-life 60 min, window 240 min,
// single jumps winsorized at 0.05 so one huge tick does not set the spread.
const VOL_WINDOW = 240;
const VOL_HALF_LIFE = 60;
const WINSOR_CAP = 0.05;
// The 0.45 scale corrects the one-minute volatility for microstructure
// noise that does not accumulate like a random walk.
const SIGMA_SCALE = 0.45;
const SIGMA_FLOOR = 0.0005;
const SIGMA_CAP = 0.008;
// Level term: room to move, added in quadrature.
const LEVEL_COEF = 0.002;
// Spread growth with horizon: (h / 240) ^ GROWTH_ALPHA.
const GROWTH_ALPHA = 0.4;
// Median reversion: this fraction of the last hour's move fades by the end
// of the horizon, growing like sqrt(h / 240).
const REVERSION = 0.1;
const REVERT_WINDOW = 60;
// Tail skew: lower tail wider by 1 + SKEW * (x - 0.05), upper tail narrower
// by the mirror amount, each clamped to [0.5, 1.8].
const SKEW = 1.5;
const SKEW_PIVOT = 0.05;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

interface MarketModel {
  x: number; // last price (the checkpoint price)
  t60: number; // move over the last hour (0 when the history is shorter)
  sigma: number; // per-minute spread, after scale, floor, cap, level term
  lowMult: number; // lower-tail width multiplier
  highMult: number; // upper-tail width multiplier
}

function buildModel(prices: number[]): MarketModel {
  const n = prices.length;
  const x = prices[n - 1];
  const t60 = n > REVERT_WINDOW ? x - prices[n - 1 - REVERT_WINDOW] : 0;
  const w = Math.min(VOL_WINDOW, Math.max(n - 1, 1));
  const diffs: number[] = [];
  for (let i = n - 1 - w; i < n - 1; i++) diffs.push(prices[i + 1] - prices[i]);
  const capped = diffs.map((d) => clamp(d, -WINSOR_CAP, WINSOR_CAP));
  // Exponential weights: the most recent minute weighs 1, halving every
  // VOL_HALF_LIFE minutes back.
  let weightSum = 0;
  let weightedMean = 0;
  for (let i = 0; i < capped.length; i++) {
    const weight = Math.pow(0.5, (capped.length - 1 - i) / VOL_HALF_LIFE);
    weightSum += weight;
    weightedMean += weight * capped[i];
  }
  weightedMean /= Math.max(weightSum, 1);
  let weightedVar = 0;
  for (let i = 0; i < capped.length; i++) {
    const weight = Math.pow(0.5, (capped.length - 1 - i) / VOL_HALF_LIFE);
    weightedVar += weight * (capped[i] - weightedMean) * (capped[i] - weightedMean);
  }
  weightedVar /= Math.max(weightSum, 1);
  const rawSigma = Math.sqrt(weightedVar);
  const scaled = clamp(rawSigma, SIGMA_FLOOR, SIGMA_CAP) * SIGMA_SCALE;
  const level = LEVEL_COEF * Math.sqrt(Math.max(x * (1 - x), 1e-6));
  const sigma = Math.sqrt(scaled * scaled + level * level);
  const skew = SKEW * (x - SKEW_PIVOT);
  return {
    x,
    t60,
    sigma,
    lowMult: clamp(1 + skew, 0.5, 1.8),
    highMult: clamp(1 - skew, 0.5, 1.8),
  };
}

function forecastRows(model: MarketModel): number[][] {
  const rows: number[][] = [];
  for (let h = 1; h <= HORIZON; h++) {
    const spread = model.sigma * Math.sqrt(HORIZON) * Math.pow(h / HORIZON, GROWTH_ALPHA);
    const median = model.x - REVERSION * model.t60 * Math.sqrt(h / HORIZON);
    const row = Z.map((z) => {
      const mult = z < 0 ? model.lowMult : z > 0 ? model.highMult : 1;
      return median + z * spread * mult;
    });
    // Clamp to [0, 1], round, and keep the row non-decreasing.
    const clean = row.map((v) => round6(clamp(v, 0, 1)));
    clean.sort((a, b) => a - b);
    rows.push(clean);
  }
  return rows;
}

function main(): void {
  const inputDir = process.env.MAKEFUN_INPUT_DIR || "/input";
  const outputDir = process.env.MAKEFUN_OUTPUT_DIR || "/output";
  fs.mkdirSync(outputDir, { recursive: true });
  const files = fs.readdirSync(inputDir).filter((f) => f.endsWith(".in")).sort();
  for (const file of files) {
    const id = file.slice(0, -3);
    const data = JSON.parse(fs.readFileSync(path.join(inputDir, file), "utf8"));
    const forecasts = data.markets.map((m: { id: string; prices: number[] }) => ({
      id: m.id,
      q: forecastRows(buildModel(m.prices)),
    }));
    fs.writeFileSync(
      path.join(outputDir, `${id}.out`),
      JSON.stringify({ forecasts }),
      "utf8",
    );
  }
}

main();
