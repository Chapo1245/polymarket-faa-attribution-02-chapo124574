# Polymarket FAA Attribution — 4h-Ahead Yes-Price Quantiles

Entry for make.fun `polymarket-faa-attribution-02`: forecast, minute by minute,
4 hours ahead, the Yes price of each market in a Polymarket family, as five
quantiles (0.05 / 0.25 / 0.5 / 0.75 / 0.95) per minute. Node 22, standard
library only, no network. `main.ts` reads every `*.in` case in the input
directory and writes one `*.out` forecast per case.

## Method

Polymarket prices move in steps — long flat stretches, then a tick, now and
then a jump. The forecast is built per market from its own recent behaviour:

- **Spread**: winsorized one-minute volatility over the last 4 hours,
  weighted toward the most recent minutes (exponential half-life 60 min),
  because volatility regimes turn over in hours, not days. Raw one-minute
  volatility overstates how far a steppy price travels, so it is scaled by
  0.45, floored and capped, and a level term is added in quadrature: a
  market's room to move grows with sqrt(x * (1 - x)).
- **Growth**: the spread grows with the horizon as (h / 240) ^ 0.4, not
  sqrt(h) — a steppy price's move distribution saturates fast; most of a
  four-hour move is already possible in the first hour.
- **Median**: the last price, with a tenth of the last hour's move faded back
  over the horizon — sharp one-hour moves partly revert.
- **Skew**: the lower tail is wider than the upper tail when the price is high
  (more room to fall than to rise) and the reverse when it is low, scaled by
  1.5 * (x - 0.05) and clamped. A price near 0 can jump up far but barely
  fall; a price near 1 is the mirror.

## Practice result

Local pinball loss on the six sealed practice cases: **0.262933** (house
persistence baseline: 0.363589 — 28% better, and better than the baseline on
all six cases). Per case: p00 0.448094, p01 0.292765, p02 0.357945,
p03 0.243761, p04 0.182745, p05 0.116071. Two runs are byte-identical;
all six cases run in ~0.4 s total (cap is 8 s per case).

## Variants tried (all graded on the same six practice cases)

| Variant | Practice loss |
|---|---|
| House persistence baseline | 0.363589 |
| Normal quantiles, raw 1-min volatility | 0.311800 |
| + mean-reversion drift (0.4) | 0.315865 |
| + jump-mixture quantiles | 0.328360 |
| + scaled volatility (0.4x) | 0.275735 |
| + EWMA volatility (half-life 60 min) | 0.270129 |
| + level term sqrt(x(1-x)) | 0.267060 |
| + boundary skew (shipped) | **0.262933** |

Rejected on the evidence: a jump-mixture shape (tails too narrow when jumps
land), raw empirical move quantiles (overlapping windows double-count jumps),
a log-space model (worse on mid/high prices), a full historical drift term
(the past window's mean move does not carry forward), and any cross-market
normalisation (the practice event's candidates sum to ~1; the final's four
FAA markets do not, so that trick would not generalise).

## Run

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```
