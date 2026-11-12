# Phase 3 Replay Lab: baseline results — RUN 1, SUPERSEDED (see docs/experiments.md E005: depth parsing bug, corrupt depth days, universe false positive)

Generated 2026-11-12T07:52:17.122217Z by the Replay Lab. Pre-registered in docs/experiments.md (shared definitions v1, E001-E004).
Returns are per trade as a % of the trade size. Lift = net return of the signal minus the mean net return of 5 random
entries on the same coin and day (same direction, delay, costs). Statistics are per independent event.

## Receipts

- Command (from `android/`): `./gradlew :engine:replayLab`
- Code commit: `94ff12de677d6ea00db6cf931447f682c7a528f6` (clean)
- Pre-registration commit: `e1785c7ced78fe607a33367ab25506b25a0d05ed`
- Dataset manifest: `docs/replay-dataset-manifest.json`, sha256 `8b8bdb1dfdd04c0d9fa01309a1163f446a6cd3b817f650a71e2ddb3de5b7d599` (12388 files, 1894 MB, every archive file checked against Binance's .CHECKSUM)
- Trial counter: 4; adjusted intervals use the two-sided level 1 - 0.05/4 (Bonferroni)
- Bootstrap: UTC-day blocks, B = 2000, seed 20261112
- Data: Binance USD-M perpetuals, development period 2025-01 to 2026-06 (holdout 2026-07 to 2026-10 not used); 158 symbols were in the monthly top-30 universe, 14 of them are no longer trading today (delisted or settling); 39379922 1m candles, 7875983 5m bars

## Results per trial (2-minute entry delay, $1,000 trade)

| Trial | Rule | Trade | Events | Mean net | Mean lift | 95% CI | Adjusted CI | Hedged lift | Hedged adj. CI | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A | CONTINUE | 8014 | -0.350% | -0.033% | [-0.074%, +0.009%] | [-0.084%, +0.018%] | -0.028% | [-0.080%, +0.023%] | **NO LIFT** |
| 2 | A | REVERT | 8014 | -0.286% | +0.023% | [-0.018%, +0.065%] | [-0.026%, +0.074%] | +0.019% | [-0.031%, +0.070%] | **NO LIFT** |
| 3 | C | CONTINUE | 20481 | -0.180% | -0.004% | [-0.013%, +0.006%] | [-0.016%, +0.009%] | -0.006% | [-0.017%, +0.005%] | **NO LIFT** |
| 4 | C | REVERT | 20481 | -0.178% | +0.000% | [-0.010%, +0.010%] | [-0.013%, +0.012%] | +0.003% | [-0.009%, +0.013%] | **NO LIFT** |

Verdict rule (E001/E002): fewer than 100 events = INCONCLUSIVE; LIFT only if the adjusted lower bound is above 0 for both raw and BTC-hedged lift; otherwise NO LIFT.

## Baseline A: naive scanner (5m move >= 2%)

Signals: 25050 raw, 14982 traded (first of each event), 12586 independent events (209 market-wide).

### CONTINUE (trial 1)

Outcomes at 2 min (traded signals, n = 14982): win 6620 (44.2%), loss 7023 (46.9%, of which 127 ambiguous: both barriers in one candle), timeout 1338 (8.9%), invalid 1 (data gap). No cost estimate: 4459; no hedge: 0; no random match: 499. Mean max favorable move +1.445%, mean max adverse move +1.410%, median minutes to the best price 2.0.

| Delay | Size | Events | Mean net | Mean lift | 95% CI | Adjusted CI |
| --- | --- | --- | --- | --- | --- | --- |
| 0s | $1000 | 8014 | -0.380% | -0.053% | [-0.090%, -0.014%] | [-0.103%, -0.005%] |
| 0s | $10000 | 8014 | -2.214% | -0.053% | [-0.090%, -0.014%] | [-0.103%, -0.005%] |
| 30s | $1000 | 8011 | -0.371% | -0.053% | [-0.094%, -0.014%] | [-0.104%, -0.003%] |
| 30s | $10000 | 8011 | -2.204% | -0.053% | [-0.094%, -0.014%] | [-0.104%, -0.003%] |
| 2m | $1000 | 8014 | -0.350% | -0.033% | [-0.074%, +0.009%] | [-0.084%, +0.018%] |
| 2m | $10000 | 8014 | -2.184% | -0.033% | [-0.074%, +0.009%] | [-0.084%, +0.018%] |
| 5m | $1000 | 8014 | -0.353% | -0.037% | [-0.074%, +0.001%] | [-0.084%, +0.008%] |
| 5m | $10000 | 8014 | -2.187% | -0.037% | [-0.074%, +0.001%] | [-0.084%, +0.008%] |

| Walk-forward fold (quarter) | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| 2025Q1 | 1685 | -0.234% | -0.111% | [-0.184%, -0.035%] |
| 2025Q2 | 899 | -0.085% | +0.032% | [-0.046%, +0.116%] |
| 2025Q3 | 840 | -1.307% | +0.091% | [-0.017%, +0.196%] |
| 2025Q4 | 2782 | -0.375% | -0.092% | [-0.174%, -0.015%] |
| 2026Q1 | 1377 | -0.059% | +0.068% | [-0.045%, +0.169%] |
| 2026Q2 | 431 | -0.145% | -0.039% | [-0.171%, +0.077%] |

| BTC regime | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| BTC 7d down, calm | 647 | -1.050% | +0.032% | [-0.062%, +0.148%] |
| BTC 7d down, normal vol | 1647 | -0.602% | -0.178% | [-0.282%, -0.079%] |
| BTC 7d down, volatile | 1474 | -0.212% | -0.051% | [-0.125%, +0.025%] |
| BTC 7d flat, calm | 1245 | -0.073% | +0.060% | [-0.047%, +0.159%] |
| BTC 7d flat, normal vol | 755 | -0.417% | +0.116% | [-0.026%, +0.256%] |
| BTC 7d flat, volatile | 430 | -0.214% | -0.037% | [-0.165%, +0.109%] |
| BTC 7d up, calm | 1158 | -0.123% | +0.010% | [-0.076%, +0.100%] |
| BTC 7d up, normal vol | 359 | -0.339% | -0.204% | [-0.425%, +0.044%] |
| BTC 7d up, volatile | 299 | -0.128% | +0.012% | [-0.170%, +0.177%] |

| Symbol tier | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| market-wide event | 207 | -0.140% | +0.027% | [-0.102%, +0.152%] |
| volume rank 1-10 | 1918 | -0.231% | -0.020% | [-0.113%, +0.076%] |
| volume rank 11+ | 5889 | -0.396% | -0.039% | [-0.087%, +0.008%] |

| Move direction | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| after a down move | 3589 | -0.394% | -0.036% | [-0.116%, +0.045%] |
| after an up move | 4218 | -0.323% | -0.033% | [-0.100%, +0.036%] |
| market-wide event | 207 | -0.140% | +0.027% | [-0.102%, +0.152%] |

### REVERT (trial 2)

Outcomes at 2 min (traded signals, n = 14982): win 6896 (46.0%), loss 6747 (45.0%, of which 127 ambiguous: both barriers in one candle), timeout 1338 (8.9%), invalid 1 (data gap). No cost estimate: 4459; no hedge: 0; no random match: 499. Mean max favorable move +1.410%, mean max adverse move +1.445%, median minutes to the best price 2.0.

| Delay | Size | Events | Mean net | Mean lift | 95% CI | Adjusted CI |
| --- | --- | --- | --- | --- | --- | --- |
| 0s | $1000 | 8014 | -0.262% | +0.037% | [-0.002%, +0.074%] | [-0.011%, +0.086%] |
| 0s | $10000 | 8014 | -2.096% | +0.037% | [-0.002%, +0.074%] | [-0.011%, +0.086%] |
| 30s | $1000 | 8011 | -0.267% | +0.044% | [+0.005%, +0.085%] | [-0.006%, +0.095%] |
| 30s | $10000 | 8011 | -2.100% | +0.044% | [+0.005%, +0.085%] | [-0.006%, +0.095%] |
| 2m | $1000 | 8014 | -0.286% | +0.023% | [-0.018%, +0.065%] | [-0.026%, +0.074%] |
| 2m | $10000 | 8014 | -2.120% | +0.023% | [-0.018%, +0.065%] | [-0.026%, +0.074%] |
| 5m | $1000 | 8014 | -0.281% | +0.030% | [-0.007%, +0.068%] | [-0.016%, +0.078%] |
| 5m | $10000 | 8014 | -2.115% | +0.030% | [-0.007%, +0.068%] | [-0.016%, +0.078%] |

| Walk-forward fold (quarter) | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| 2025Q1 | 1685 | -0.002% | +0.104% | [+0.028%, +0.178%] |
| 2025Q2 | 899 | -0.157% | -0.045% | [-0.130%, +0.035%] |
| 2025Q3 | 840 | -1.486% | -0.099% | [-0.205%, +0.007%] |
| 2025Q4 | 2782 | -0.197% | +0.083% | [+0.005%, +0.165%] |
| 2026Q1 | 1377 | -0.195% | -0.081% | [-0.180%, +0.031%] |
| 2026Q2 | 431 | -0.096% | +0.038% | [-0.077%, +0.167%] |

| BTC regime | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| BTC 7d down, calm | 647 | -1.052% | -0.044% | [-0.162%, +0.049%] |
| BTC 7d down, normal vol | 1647 | -0.334% | +0.169% | [+0.070%, +0.272%] |
| BTC 7d down, volatile | 1474 | -0.136% | +0.048% | [-0.028%, +0.121%] |
| BTC 7d flat, calm | 1245 | -0.187% | -0.069% | [-0.167%, +0.038%] |
| BTC 7d flat, normal vol | 755 | -0.572% | -0.125% | [-0.264%, +0.019%] |
| BTC 7d flat, volatile | 430 | -0.031% | +0.026% | [-0.125%, +0.154%] |
| BTC 7d up, calm | 1158 | -0.148% | -0.024% | [-0.111%, +0.062%] |
| BTC 7d up, normal vol | 359 | +0.028% | +0.193% | [-0.052%, +0.417%] |
| BTC 7d up, volatile | 299 | -0.113% | -0.022% | [-0.184%, +0.161%] |

| Symbol tier | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| market-wide event | 207 | -0.175% | -0.034% | [-0.160%, +0.098%] |
| volume rank 1-10 | 1918 | -0.209% | +0.009% | [-0.086%, +0.101%] |
| volume rank 11+ | 5889 | -0.316% | +0.030% | [-0.018%, +0.078%] |

| Move direction | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| after a down move | 3589 | -0.323% | +0.028% | [-0.052%, +0.108%] |
| after an up move | 4218 | -0.261% | +0.022% | [-0.047%, +0.089%] |
| market-wide event | 207 | -0.175% | -0.034% | [-0.160%, +0.098%] |

## Baseline C: app's Track A Confirmed rule (move >= 2 ATR + gates)

Signals: 43082 raw, 36897 traded (first of each event), 20483 independent events (1606 market-wide).

### CONTINUE (trial 3)

Outcomes at 2 min (traded signals, n = 36897): win 17805 (48.3%), loss 18106 (49.1%, of which 156 ambiguous: both barriers in one candle), timeout 985 (2.7%), invalid 1 (data gap). No cost estimate: 0; no hedge: 0; no random match: 0. Mean max favorable move +0.449%, mean max adverse move +0.409%, median minutes to the best price 1.0.

| Delay | Size | Events | Mean net | Mean lift | 95% CI | Adjusted CI |
| --- | --- | --- | --- | --- | --- | --- |
| 0s | $1000 | 20481 | -0.187% | -0.011% | [-0.021%, +0.000%] | [-0.024%, +0.003%] |
| 0s | $10000 | 20481 | -0.796% | -0.011% | [-0.021%, +0.000%] | [-0.024%, +0.003%] |
| 30s | $1000 | 20479 | -0.198% | -0.019% | [-0.029%, -0.008%] | [-0.032%, -0.005%] |
| 30s | $10000 | 20479 | -0.808% | -0.019% | [-0.029%, -0.008%] | [-0.032%, -0.005%] |
| 2m | $1000 | 20481 | -0.180% | -0.004% | [-0.013%, +0.006%] | [-0.016%, +0.009%] |
| 2m | $10000 | 20481 | -0.789% | -0.004% | [-0.013%, +0.006%] | [-0.016%, +0.009%] |
| 5m | $1000 | 20481 | -0.177% | -0.004% | [-0.014%, +0.007%] | [-0.017%, +0.010%] |
| 5m | $10000 | 20481 | -0.786% | -0.004% | [-0.014%, +0.007%] | [-0.017%, +0.010%] |

| Walk-forward fold (quarter) | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| 2025Q1 | 3282 | -0.115% | -0.003% | [-0.028%, +0.022%] |
| 2025Q2 | 3542 | -0.089% | +0.019% | [+0.001%, +0.036%] |
| 2025Q3 | 3757 | -0.364% | -0.009% | [-0.027%, +0.009%] |
| 2025Q4 | 4206 | -0.197% | +0.013% | [-0.015%, +0.044%] |
| 2026Q1 | 3675 | -0.151% | -0.039% | [-0.062%, -0.017%] |
| 2026Q2 | 2019 | -0.118% | -0.008% | [-0.026%, +0.010%] |

| BTC regime | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| BTC 7d down, calm | 2399 | -0.308% | +0.011% | [-0.014%, +0.036%] |
| BTC 7d down, normal vol | 2489 | -0.266% | -0.028% | [-0.060%, +0.003%] |
| BTC 7d down, volatile | 2378 | -0.133% | +0.008% | [-0.020%, +0.040%] |
| BTC 7d flat, calm | 4843 | -0.129% | +0.008% | [-0.013%, +0.032%] |
| BTC 7d flat, normal vol | 1579 | -0.257% | +0.017% | [-0.019%, +0.052%] |
| BTC 7d flat, volatile | 1188 | -0.148% | -0.020% | [-0.057%, +0.015%] |
| BTC 7d up, calm | 3395 | -0.112% | -0.007% | [-0.027%, +0.014%] |
| BTC 7d up, normal vol | 1476 | -0.183% | -0.032% | [-0.060%, -0.000%] |
| BTC 7d up, volatile | 734 | -0.155% | -0.041% | [-0.089%, +0.007%] |

| Symbol tier | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| market-wide event | 1606 | -0.135% | +0.006% | [-0.011%, +0.022%] |
| volume rank 1-10 | 5587 | -0.110% | +0.006% | [-0.014%, +0.026%] |
| volume rank 11+ | 13288 | -0.215% | -0.009% | [-0.021%, +0.003%] |

| Move direction | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| after a down move | 8499 | -0.114% | -0.012% | [-0.028%, +0.005%] |
| after an up move | 10376 | -0.241% | +0.001% | [-0.014%, +0.016%] |
| market-wide event | 1606 | -0.135% | +0.006% | [-0.011%, +0.022%] |

### REVERT (trial 4)

Outcomes at 2 min (traded signals, n = 36897): win 17950 (48.7%), loss 17961 (48.7%, of which 156 ambiguous: both barriers in one candle), timeout 985 (2.7%), invalid 1 (data gap). No cost estimate: 0; no hedge: 0; no random match: 0. Mean max favorable move +0.409%, mean max adverse move +0.449%, median minutes to the best price 2.0.

| Delay | Size | Events | Mean net | Mean lift | 95% CI | Adjusted CI |
| --- | --- | --- | --- | --- | --- | --- |
| 0s | $1000 | 20481 | -0.173% | +0.005% | [-0.006%, +0.015%] | [-0.009%, +0.018%] |
| 0s | $10000 | 20481 | -0.782% | +0.005% | [-0.006%, +0.015%] | [-0.009%, +0.018%] |
| 30s | $1000 | 20479 | -0.160% | +0.015% | [+0.005%, +0.026%] | [+0.001%, +0.028%] |
| 30s | $10000 | 20479 | -0.769% | +0.015% | [+0.005%, +0.026%] | [+0.001%, +0.028%] |
| 2m | $1000 | 20481 | -0.178% | +0.000% | [-0.010%, +0.010%] | [-0.013%, +0.012%] |
| 2m | $10000 | 20481 | -0.787% | +0.000% | [-0.010%, +0.010%] | [-0.013%, +0.012%] |
| 5m | $1000 | 20481 | -0.180% | +0.000% | [-0.010%, +0.011%] | [-0.014%, +0.014%] |
| 5m | $10000 | 20481 | -0.789% | +0.000% | [-0.010%, +0.011%] | [-0.014%, +0.014%] |

| Walk-forward fold (quarter) | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| 2025Q1 | 3282 | -0.106% | +0.000% | [-0.025%, +0.025%] |
| 2025Q2 | 3542 | -0.135% | -0.021% | [-0.038%, -0.004%] |
| 2025Q3 | 3757 | -0.351% | +0.007% | [-0.011%, +0.025%] |
| 2025Q4 | 4206 | -0.221% | -0.019% | [-0.050%, +0.009%] |
| 2026Q1 | 3675 | -0.094% | +0.035% | [+0.014%, +0.058%] |
| 2026Q2 | 2019 | -0.109% | +0.004% | [-0.014%, +0.022%] |

| BTC regime | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| BTC 7d down, calm | 2399 | -0.328% | -0.013% | [-0.038%, +0.011%] |
| BTC 7d down, normal vol | 2489 | -0.224% | +0.021% | [-0.009%, +0.051%] |
| BTC 7d down, volatile | 2378 | -0.150% | -0.011% | [-0.042%, +0.017%] |
| BTC 7d flat, calm | 4843 | -0.152% | -0.009% | [-0.033%, +0.011%] |
| BTC 7d flat, normal vol | 1579 | -0.266% | -0.021% | [-0.057%, +0.017%] |
| BTC 7d flat, volatile | 1188 | -0.087% | +0.016% | [-0.018%, +0.053%] |
| BTC 7d up, calm | 3395 | -0.127% | +0.001% | [-0.020%, +0.020%] |
| BTC 7d up, normal vol | 1476 | -0.136% | +0.027% | [-0.004%, +0.054%] |
| BTC 7d up, volatile | 734 | -0.071% | +0.040% | [-0.007%, +0.086%] |

| Symbol tier | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| market-wide event | 1606 | -0.148% | -0.008% | [-0.024%, +0.008%] |
| volume rank 1-10 | 5587 | -0.137% | -0.009% | [-0.029%, +0.011%] |
| volume rank 11+ | 13288 | -0.199% | +0.005% | [-0.007%, +0.017%] |

| Move direction | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| after a down move | 8499 | -0.125% | +0.008% | [-0.009%, +0.024%] |
| after an up move | 10376 | -0.225% | -0.005% | [-0.020%, +0.010%] |
| market-wide event | 1606 | -0.148% | -0.008% | [-0.024%, +0.008%] |

## Placebo tests (E003; CONTINUE, 2 min, $1,000; pass = 95% CI contains 0)

| Rule | Placebo | Judged on | Events | Mean lift | 95% CI | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| A | time shift | raw net lift | 9473 | +0.011% | [-0.011%, +0.033%] | yes |
| A | shuffled labels | raw net lift | 8014 | -0.009% | [-0.063%, +0.040%] | yes |
| A | random symbol | BTC-hedged net lift | 10810 | -0.005% | [-0.017%, +0.009%] | yes |
| A | random symbol | raw net lift (reported only) | 10810 | -0.004% | [-0.020%, +0.012%] | - |
| C | time shift | raw net lift | 32586 | -0.005% | [-0.012%, +0.002%] | yes |
| C | shuffled labels | raw net lift | 20481 | -0.014% | [-0.036%, +0.006%] | yes |
| C | random symbol | BTC-hedged net lift | 18715 | +0.001% | [-0.006%, +0.008%] | yes |
| C | random symbol | raw net lift (reported only) | 18715 | +0.000% | [-0.008%, +0.009%] | - |

## Precision at an alert budget (E004; ranked by plain % move; CONTINUE, 2 min, $1,000)

| Rule | Top K per day | Signals | Days | Win rate | Mean net |
| --- | --- | --- | --- | --- | --- |
| A | 5 | 2321 | 518 | 45.7% | -0.355% |
| A | 10 | 4041 | 518 | 45.6% | -0.363% |
| A | 20 | 6279 | 518 | 44.9% | -0.359% |
| C | 5 | 2730 | 546 | 48.2% | -0.186% |
| C | 10 | 5456 | 546 | 47.7% | -0.175% |
| C | 20 | 10830 | 546 | 47.6% | -0.208% |

Not validated, descriptive only. No probability or accuracy claim follows from these tables.
