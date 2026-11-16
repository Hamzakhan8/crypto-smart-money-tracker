# Phase 3 Replay Lab: baseline results

Generated 2026-11-16T04:42:42.127881200Z by the Replay Lab. Pre-registered in docs/experiments.md: shared definitions v1 with the E005 corrections (v1.1), E001-E004.
The four trials below were run twice (run 1 had errors, see E005), so the trial counter is 8 and adjusted intervals use it.
Returns are per trade as a % of the trade size. Lift = net return of the signal minus the mean net return of 5 random
entries on the same coin and day (same direction, delay, costs). Statistics are per independent event.

## Receipts

- Command (from `android/`): `./gradlew :engine:replayLab`
- Code commit: `d5f8c5abd7b6e19b3239996aeb0f31a7af66240f` (clean)
- Pre-registration commit: `05ad63d02a9bf3acaf5992ec2a89110d46e86af9`
- Dataset manifest: `docs/replay-dataset-manifest.json`, sha256 `20721e1f2f4c758251e162f262a0d70b3fdd5495cc290d0521203178f40cc1e0` (12352 files, 1869 MB, every archive file checked against Binance's .CHECKSUM)
- Trial counter: 8; adjusted intervals use the two-sided level 1 - 0.05/8 (Bonferroni)
- Bootstrap: UTC-day blocks, B = 2000, seed 20261112
- Data: Binance USD-M perpetuals, development period 2025-01 to 2026-06 (holdout 2026-07 to 2026-10 not used); 157 symbols were in the monthly top-30 universe, 14 of them are no longer trading today (delisted or settling); 38861522 1m candles, 7772303 5m bars

## Results per trial (2-minute entry delay, $1,000 trade)

| Trial | Rule | Trade | Events | Mean net | Mean lift | 95% CI | Adjusted CI | Hedged lift | Hedged adj. CI | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | A | CONTINUE | 11278 | -0.156% | -0.035% | [-0.074%, +0.003%] | [-0.091%, +0.018%] | -0.031% | [-0.084%, +0.019%] | **NO LIFT** |
| 2 | A | REVERT | 11278 | -0.103% | +0.025% | [-0.012%, +0.064%] | [-0.027%, +0.081%] | +0.021% | [-0.028%, +0.076%] | **NO LIFT** |
| 3 | C | CONTINUE | 23564 | -0.116% | -0.001% | [-0.012%, +0.009%] | [-0.015%, +0.014%] | -0.004% | [-0.017%, +0.009%] | **NO LIFT** |
| 4 | C | REVERT | 23564 | -0.120% | -0.004% | [-0.014%, +0.007%] | [-0.019%, +0.010%] | -0.001% | [-0.015%, +0.012%] | **NO LIFT** |

Verdict rule (E001/E002): fewer than 100 events = INCONCLUSIVE; LIFT only if the adjusted lower bound is above 0 for both raw and BTC-hedged lift; otherwise NO LIFT.

## Baseline A: naive scanner (5m move >= 2%)

Signals: 24454 raw, 14695 traded (first of each event), 12330 independent events (206 market-wide).

### CONTINUE (trial 1)

Outcomes at 2 min (traded signals, n = 14695): win 6489 (44.2%), loss 6899 (47.0%, of which 124 ambiguous: both barriers in one candle), timeout 1306 (8.9%), invalid 1 (data gap). No cost estimate: 755; no hedge: 0; no random match: 499. Mean max favorable move +1.436%, mean max adverse move +1.402%, median minutes to the best price 2.0.

| Delay | Size | Events | Mean net | Mean lift | 95% CI | Adjusted CI |
| --- | --- | --- | --- | --- | --- | --- |
| 0s | $1000 | 11278 | -0.159% | -0.037% | [-0.074%, -0.000%] | [-0.089%, +0.019%] |
| 0s | $10000 | 11278 | -0.280% | -0.037% | [-0.074%, -0.000%] | [-0.089%, +0.019%] |
| 30s | $1000 | 11273 | -0.171% | -0.050% | [-0.087%, -0.015%] | [-0.101%, -0.002%] |
| 30s | $10000 | 11273 | -0.292% | -0.050% | [-0.087%, -0.015%] | [-0.101%, -0.002%] |
| 2m | $1000 | 11278 | -0.156% | -0.035% | [-0.074%, +0.003%] | [-0.091%, +0.018%] |
| 2m | $10000 | 11278 | -0.277% | -0.035% | [-0.074%, +0.003%] | [-0.091%, +0.018%] |
| 5m | $1000 | 11278 | -0.134% | -0.012% | [-0.044%, +0.023%] | [-0.055%, +0.037%] |
| 5m | $10000 | 11278 | -0.254% | -0.012% | [-0.044%, +0.023%] | [-0.055%, +0.037%] |

| Walk-forward fold (quarter) | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| 2025Q1 | 1685 | -0.234% | -0.111% | [-0.184%, -0.035%] |
| 2025Q2 | 899 | -0.085% | +0.032% | [-0.046%, +0.116%] |
| 2025Q3 | 840 | -0.027% | +0.091% | [-0.017%, +0.196%] |
| 2025Q4 | 2259 | -0.227% | -0.098% | [-0.177%, -0.019%] |
| 2026Q1 | 2359 | -0.043% | +0.072% | [-0.016%, +0.165%] |
| 2026Q2 | 3236 | -0.204% | -0.080% | [-0.156%, -0.007%] |

| BTC regime | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| BTC 7d down, calm | 1207 | -0.139% | -0.012% | [-0.107%, +0.102%] |
| BTC 7d down, normal vol | 1868 | -0.152% | -0.078% | [-0.183%, +0.022%] |
| BTC 7d down, volatile | 2234 | -0.174% | -0.073% | [-0.160%, +0.007%] |
| BTC 7d flat, calm | 1592 | -0.085% | +0.059% | [-0.030%, +0.151%] |
| BTC 7d flat, normal vol | 887 | -0.124% | +0.033% | [-0.121%, +0.188%] |
| BTC 7d flat, volatile | 708 | -0.261% | -0.086% | [-0.203%, +0.047%] |
| BTC 7d up, calm | 1227 | -0.159% | -0.039% | [-0.127%, +0.052%] |
| BTC 7d up, normal vol | 1048 | -0.229% | -0.104% | [-0.239%, +0.055%] |
| BTC 7d up, volatile | 507 | -0.105% | +0.053% | [-0.116%, +0.196%] |

| Symbol tier | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| market-wide event | 206 | -0.097% | +0.029% | [-0.100%, +0.159%] |
| volume rank 1-10 | 2798 | -0.140% | -0.058% | [-0.132%, +0.018%] |
| volume rank 11+ | 8274 | -0.163% | -0.028% | [-0.070%, +0.017%] |

| Move direction | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| after a down move | 5220 | -0.138% | -0.031% | [-0.097%, +0.032%] |
| after an up move | 5852 | -0.174% | -0.040% | [-0.100%, +0.023%] |
| market-wide event | 206 | -0.097% | +0.029% | [-0.100%, +0.159%] |

### REVERT (trial 2)

Outcomes at 2 min (traded signals, n = 14695): win 6775 (46.1%), loss 6613 (45.0%, of which 124 ambiguous: both barriers in one candle), timeout 1306 (8.9%), invalid 1 (data gap). No cost estimate: 755; no hedge: 0; no random match: 499. Mean max favorable move +1.402%, mean max adverse move +1.436%, median minutes to the best price 2.0.

| Delay | Size | Events | Mean net | Mean lift | 95% CI | Adjusted CI |
| --- | --- | --- | --- | --- | --- | --- |
| 0s | $1000 | 11278 | -0.106% | +0.020% | [-0.017%, +0.057%] | [-0.037%, +0.070%] |
| 0s | $10000 | 11278 | -0.227% | +0.020% | [-0.017%, +0.057%] | [-0.037%, +0.070%] |
| 30s | $1000 | 11273 | -0.089% | +0.039% | [+0.004%, +0.077%] | [-0.011%, +0.091%] |
| 30s | $10000 | 11273 | -0.210% | +0.039% | [+0.004%, +0.077%] | [-0.011%, +0.091%] |
| 2m | $1000 | 11278 | -0.103% | +0.025% | [-0.012%, +0.064%] | [-0.027%, +0.081%] |
| 2m | $10000 | 11278 | -0.223% | +0.025% | [-0.012%, +0.064%] | [-0.027%, +0.081%] |
| 5m | $1000 | 11278 | -0.123% | +0.003% | [-0.031%, +0.036%] | [-0.047%, +0.047%] |
| 5m | $10000 | 11278 | -0.244% | +0.003% | [-0.031%, +0.036%] | [-0.047%, +0.047%] |

| Walk-forward fold (quarter) | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| 2025Q1 | 1685 | -0.002% | +0.104% | [+0.028%, +0.178%] |
| 2025Q2 | 899 | -0.157% | -0.045% | [-0.130%, +0.035%] |
| 2025Q3 | 840 | -0.206% | -0.099% | [-0.205%, +0.007%] |
| 2025Q4 | 2259 | -0.038% | +0.087% | [+0.007%, +0.167%] |
| 2026Q1 | 2359 | -0.217% | -0.079% | [-0.172%, +0.009%] |
| 2026Q2 | 3236 | -0.071% | +0.069% | [-0.003%, +0.146%] |

| BTC regime | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| BTC 7d down, calm | 1207 | -0.126% | -0.005% | [-0.117%, +0.088%] |
| BTC 7d down, normal vol | 1868 | -0.111% | +0.067% | [-0.033%, +0.171%] |
| BTC 7d down, volatile | 2234 | -0.077% | +0.069% | [-0.010%, +0.157%] |
| BTC 7d flat, calm | 1592 | -0.171% | -0.068% | [-0.161%, +0.020%] |
| BTC 7d flat, normal vol | 887 | -0.144% | -0.043% | [-0.198%, +0.109%] |
| BTC 7d flat, volatile | 708 | -0.001% | +0.082% | [-0.054%, +0.199%] |
| BTC 7d up, calm | 1227 | -0.095% | +0.023% | [-0.068%, +0.111%] |
| BTC 7d up, normal vol | 1048 | -0.034% | +0.099% | [-0.058%, +0.232%] |
| BTC 7d up, volatile | 507 | -0.141% | -0.061% | [-0.203%, +0.108%] |

| Symbol tier | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| market-wide event | 206 | -0.140% | -0.037% | [-0.169%, +0.092%] |
| volume rank 1-10 | 2798 | -0.093% | +0.045% | [-0.031%, +0.119%] |
| volume rank 11+ | 8274 | -0.105% | +0.020% | [-0.026%, +0.063%] |

| Move direction | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| after a down move | 5220 | -0.120% | +0.023% | [-0.039%, +0.088%] |
| after an up move | 5852 | -0.086% | +0.029% | [-0.034%, +0.088%] |
| market-wide event | 206 | -0.140% | -0.037% | [-0.169%, +0.092%] |

## Baseline C: app's Track A Confirmed rule (move >= 2 ATR + gates)

Signals: 47872 raw, 40906 traded (first of each event), 23567 independent events (1685 market-wide).

### CONTINUE (trial 3)

Outcomes at 2 min (traded signals, n = 40906): win 19727 (48.2%), loss 20076 (49.1%, of which 190 ambiguous: both barriers in one candle), timeout 1102 (2.7%), invalid 1 (data gap). No cost estimate: 0; no hedge: 0; no random match: 0. Mean max favorable move +0.477%, mean max adverse move +0.434%, median minutes to the best price 1.0.

| Delay | Size | Events | Mean net | Mean lift | 95% CI | Adjusted CI |
| --- | --- | --- | --- | --- | --- | --- |
| 0s | $1000 | 23564 | -0.127% | -0.010% | [-0.021%, +0.000%] | [-0.024%, +0.006%] |
| 0s | $10000 | 23564 | -0.177% | -0.010% | [-0.021%, +0.000%] | [-0.024%, +0.006%] |
| 30s | $1000 | 23561 | -0.140% | -0.021% | [-0.032%, -0.011%] | [-0.036%, -0.006%] |
| 30s | $10000 | 23561 | -0.190% | -0.021% | [-0.032%, -0.011%] | [-0.036%, -0.006%] |
| 2m | $1000 | 23564 | -0.116% | -0.001% | [-0.012%, +0.009%] | [-0.015%, +0.014%] |
| 2m | $10000 | 23564 | -0.166% | -0.001% | [-0.012%, +0.009%] | [-0.015%, +0.014%] |
| 5m | $1000 | 23564 | -0.115% | -0.001% | [-0.011%, +0.011%] | [-0.016%, +0.015%] |
| 5m | $10000 | 23564 | -0.165% | -0.001% | [-0.011%, +0.011%] | [-0.016%, +0.015%] |

| Walk-forward fold (quarter) | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| 2025Q1 | 3273 | -0.115% | -0.003% | [-0.028%, +0.022%] |
| 2025Q2 | 3542 | -0.089% | +0.019% | [+0.001%, +0.036%] |
| 2025Q3 | 3774 | -0.119% | -0.011% | [-0.029%, +0.008%] |
| 2025Q4 | 4237 | -0.103% | +0.016% | [-0.011%, +0.047%] |
| 2026Q1 | 4356 | -0.153% | -0.041% | [-0.066%, -0.014%] |
| 2026Q2 | 4382 | -0.111% | +0.016% | [-0.010%, +0.040%] |

| BTC regime | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| BTC 7d down, calm | 2904 | -0.098% | +0.021% | [-0.005%, +0.047%] |
| BTC 7d down, normal vol | 2797 | -0.125% | -0.015% | [-0.050%, +0.022%] |
| BTC 7d down, volatile | 2903 | -0.123% | -0.006% | [-0.034%, +0.024%] |
| BTC 7d flat, calm | 5282 | -0.102% | +0.009% | [-0.011%, +0.032%] |
| BTC 7d flat, normal vol | 1844 | -0.108% | +0.016% | [-0.022%, +0.059%] |
| BTC 7d flat, volatile | 1373 | -0.157% | -0.038% | [-0.077%, -0.003%] |
| BTC 7d up, calm | 3551 | -0.109% | -0.010% | [-0.030%, +0.012%] |
| BTC 7d up, normal vol | 2030 | -0.130% | -0.001% | [-0.038%, +0.037%] |
| BTC 7d up, volatile | 880 | -0.152% | -0.022% | [-0.072%, +0.029%] |

| Symbol tier | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| market-wide event | 1685 | -0.106% | +0.007% | [-0.010%, +0.024%] |
| volume rank 1-10 | 5999 | -0.091% | +0.014% | [-0.007%, +0.036%] |
| volume rank 11+ | 15880 | -0.126% | -0.008% | [-0.020%, +0.005%] |

| Move direction | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| after a down move | 10049 | -0.105% | -0.001% | [-0.018%, +0.018%] |
| after an up move | 11830 | -0.126% | -0.003% | [-0.018%, +0.011%] |
| market-wide event | 1685 | -0.106% | +0.007% | [-0.010%, +0.024%] |

### REVERT (trial 4)

Outcomes at 2 min (traded signals, n = 40906): win 19886 (48.6%), loss 19917 (48.7%, of which 190 ambiguous: both barriers in one candle), timeout 1102 (2.7%), invalid 1 (data gap). No cost estimate: 0; no hedge: 0; no random match: 0. Mean max favorable move +0.434%, mean max adverse move +0.477%, median minutes to the best price 2.0.

| Delay | Size | Events | Mean net | Mean lift | 95% CI | Adjusted CI |
| --- | --- | --- | --- | --- | --- | --- |
| 0s | $1000 | 23564 | -0.112% | +0.003% | [-0.007%, +0.013%] | [-0.013%, +0.016%] |
| 0s | $10000 | 23564 | -0.161% | +0.003% | [-0.007%, +0.013%] | [-0.013%, +0.016%] |
| 30s | $1000 | 23561 | -0.097% | +0.016% | [+0.005%, +0.027%] | [+0.000%, +0.031%] |
| 30s | $10000 | 23561 | -0.146% | +0.016% | [+0.005%, +0.027%] | [+0.000%, +0.031%] |
| 2m | $1000 | 23564 | -0.120% | -0.004% | [-0.014%, +0.007%] | [-0.019%, +0.010%] |
| 2m | $10000 | 23564 | -0.170% | -0.004% | [-0.014%, +0.007%] | [-0.019%, +0.010%] |
| 5m | $1000 | 23564 | -0.121% | -0.004% | [-0.016%, +0.007%] | [-0.020%, +0.011%] |
| 5m | $10000 | 23564 | -0.171% | -0.004% | [-0.016%, +0.007%] | [-0.020%, +0.011%] |

| Walk-forward fold (quarter) | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| 2025Q1 | 3273 | -0.106% | +0.001% | [-0.024%, +0.025%] |
| 2025Q2 | 3542 | -0.135% | -0.021% | [-0.038%, -0.004%] |
| 2025Q3 | 3774 | -0.103% | +0.009% | [-0.009%, +0.027%] |
| 2025Q4 | 4237 | -0.137% | -0.022% | [-0.053%, +0.006%] |
| 2026Q1 | 4356 | -0.091% | +0.035% | [+0.007%, +0.062%] |
| 2026Q2 | 4382 | -0.147% | -0.027% | [-0.052%, +0.000%] |

| BTC regime | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| BTC 7d down, calm | 2904 | -0.139% | -0.029% | [-0.058%, -0.003%] |
| BTC 7d down, normal vol | 2797 | -0.118% | +0.005% | [-0.032%, +0.040%] |
| BTC 7d down, volatile | 2903 | -0.117% | +0.002% | [-0.026%, +0.030%] |
| BTC 7d flat, calm | 5282 | -0.127% | -0.011% | [-0.034%, +0.009%] |
| BTC 7d flat, normal vol | 1844 | -0.132% | -0.022% | [-0.069%, +0.020%] |
| BTC 7d flat, volatile | 1373 | -0.080% | +0.033% | [-0.003%, +0.074%] |
| BTC 7d up, calm | 3551 | -0.124% | +0.003% | [-0.019%, +0.023%] |
| BTC 7d up, normal vol | 2030 | -0.112% | -0.003% | [-0.041%, +0.033%] |
| BTC 7d up, volatile | 880 | -0.082% | +0.020% | [-0.030%, +0.068%] |

| Symbol tier | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| market-wide event | 1685 | -0.118% | -0.009% | [-0.026%, +0.008%] |
| volume rank 1-10 | 5999 | -0.128% | -0.020% | [-0.042%, +0.002%] |
| volume rank 11+ | 15880 | -0.118% | +0.002% | [-0.010%, +0.015%] |

| Move direction | Events | Mean net | Mean lift | 95% CI |
| --- | --- | --- | --- | --- |
| after a down move | 10049 | -0.132% | -0.004% | [-0.023%, +0.013%] |
| after an up move | 11830 | -0.111% | -0.004% | [-0.018%, +0.011%] |
| market-wide event | 1685 | -0.118% | -0.009% | [-0.026%, +0.008%] |

## Placebo tests (E003; CONTINUE, 2 min, $1,000; pass = 95% CI contains 0)

| Rule | Placebo | Judged on | Events | Mean lift | 95% CI | Pass |
| --- | --- | --- | --- | --- | --- | --- |
| A | time shift | raw net lift | 12504 | -0.002% | [-0.022%, +0.020%] | yes |
| A | shuffled labels | raw net lift | 11278 | -0.007% | [-0.033%, +0.018%] | yes |
| A | random symbol | BTC-hedged net lift | 11734 | +0.011% | [-0.001%, +0.024%] | yes |
| A | random symbol | raw net lift (reported only) | 11734 | +0.013% | [-0.002%, +0.028%] | - |
| C | time shift | raw net lift | 35961 | -0.002% | [-0.008%, +0.006%] | yes |
| C | shuffled labels | raw net lift | 23564 | +0.008% | [-0.001%, +0.017%] | yes |
| C | random symbol | BTC-hedged net lift | 22513 | +0.001% | [-0.006%, +0.008%] | yes |
| C | random symbol | raw net lift (reported only) | 22513 | +0.004% | [-0.004%, +0.012%] | - |

## Precision at an alert budget (E004; ranked by plain % move; CONTINUE, 2 min, $1,000)

| Rule | Top K per day | Signals | Days | Win rate | Mean net |
| --- | --- | --- | --- | --- | --- |
| A | 5 | 2569 | 541 | 45.4% | -0.104% |
| A | 10 | 4703 | 541 | 45.6% | -0.105% |
| A | 20 | 7884 | 541 | 44.6% | -0.144% |
| C | 5 | 2730 | 546 | 48.2% | -0.068% |
| C | 10 | 5460 | 546 | 47.6% | -0.100% |
| C | 20 | 10916 | 546 | 48.3% | -0.105% |

Not validated, descriptive only. No probability or accuracy claim follows from these tables.
