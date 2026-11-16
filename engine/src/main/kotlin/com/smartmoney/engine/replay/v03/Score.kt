package com.smartmoney.engine.replay.v03

import kotlin.math.exp

/**
 * E006 score: x values standardized with train mean / sd (winsorized at the train 1st / 99th percentiles; unknown =
 * train mean), L2 logistic regression (lambda = 1, intercept not penalized) fit on train by Newton steps, and the score
 * = 100 x the train percentile of the predicted probability. Everything is fixed from train data only.
 */
class ScoreModel private constructor(
    val features: List<Int>,
    private val lo: DoubleArray,
    private val hi: DoubleArray,
    private val mean: DoubleArray,
    private val sd: DoubleArray,
    val beta: DoubleArray,
    private val trainProbs: DoubleArray,
) {
    private fun row(x: DoubleArray): DoubleArray = DoubleArray(features.size + 1) { k ->
        if (k == 0) 1.0 else {
            val f = k - 1
            val v = x[features[f]]
            if (v.isNaN()) 0.0 else ((v.coerceIn(lo[f], hi[f]) - mean[f]) / sd[f])
        }
    }

    fun probability(x: DoubleArray): Double = sigmoid(dot(beta, row(x)))

    /** 0-100: share of train setups with a lower or equal predicted probability. */
    fun score(x: DoubleArray): Double {
        val p = probability(x)
        var lo = 0
        var hi = trainProbs.size // first index with a value > p
        while (lo < hi) {
            val mid = (lo + hi) ushr 1
            if (trainProbs[mid] <= p) lo = mid + 1 else hi = mid
        }
        return 100.0 * lo / trainProbs.size
    }

    companion object {
        const val LAMBDA = 1.0

        fun fit(features: List<Int>, xs: List<DoubleArray>, y: List<Boolean>, iterations: Int = 30): ScoreModel {
            val k = features.size
            val lo = DoubleArray(k); val hi = DoubleArray(k); val mean = DoubleArray(k); val sd = DoubleArray(k)
            for (f in 0 until k) {
                val vals = xs.map { it[features[f]] }.filter { !it.isNaN() }.sorted()
                if (vals.isEmpty()) { lo[f] = 0.0; hi[f] = 0.0; mean[f] = 0.0; sd[f] = 1.0; continue }
                lo[f] = vals[(0.01 * (vals.size - 1)).toInt()]
                hi[f] = vals[(0.99 * (vals.size - 1)).toInt()]
                val w = vals.map { it.coerceIn(lo[f], hi[f]) }
                mean[f] = w.average()
                val s = kotlin.math.sqrt(w.sumOf { (it - mean[f]) * (it - mean[f]) } / maxOf(1, w.size - 1))
                sd[f] = if (s > 0) s else 1.0
            }
            val tmp = ScoreModel(features, lo, hi, mean, sd, DoubleArray(k + 1), DoubleArray(0))
            val rows = xs.map { tmp.row(it) }
            val beta = DoubleArray(k + 1)
            repeat(iterations) {
                val g = DoubleArray(k + 1)
                val h = Array(k + 1) { DoubleArray(k + 1) }
                for ((n, r) in rows.withIndex()) {
                    val p = sigmoid(dot(beta, r))
                    val err = (if (y[n]) 1.0 else 0.0) - p
                    val w = p * (1 - p)
                    for (a in 0..k) {
                        g[a] += err * r[a]
                        for (b in 0..k) h[a][b] += w * r[a] * r[b]
                    }
                }
                for (a in 1..k) { g[a] -= LAMBDA * beta[a]; h[a][a] += LAMBDA }
                val step = solve(h, g) ?: return@repeat
                for (a in 0..k) beta[a] += step[a]
            }
            val probs = rows.map { sigmoid(dot(beta, it)) }.sorted().toDoubleArray()
            return ScoreModel(features, lo, hi, mean, sd, beta, probs)
        }

        fun sigmoid(z: Double) = 1.0 / (1.0 + exp(-z))
        fun dot(a: DoubleArray, b: DoubleArray): Double { var s = 0.0; for (i in a.indices) s += a[i] * b[i]; return s }

        /** Gaussian elimination with partial pivoting; null if singular. */
        fun solve(a0: Array<DoubleArray>, b0: DoubleArray): DoubleArray? {
            val n = b0.size
            val a = Array(n) { a0[it].copyOf() }
            val b = b0.copyOf()
            for (col in 0 until n) {
                var piv = col
                for (r in col + 1 until n) if (kotlin.math.abs(a[r][col]) > kotlin.math.abs(a[piv][col])) piv = r
                if (kotlin.math.abs(a[piv][col]) < 1e-12) return null
                val tr = a[col]; a[col] = a[piv]; a[piv] = tr
                val tb = b[col]; b[col] = b[piv]; b[piv] = tb
                for (r in col + 1 until n) {
                    val f = a[r][col] / a[col][col]
                    for (c in col until n) a[r][c] -= f * a[col][c]
                    b[r] -= f * b[col]
                }
            }
            val x = DoubleArray(n)
            for (r in n - 1 downTo 0) {
                var s = b[r]
                for (c in r + 1 until n) s -= a[r][c] * x[c]
                x[r] = s / a[r][r]
            }
            return x
        }

        /** Phi correlation of two pass-flag vectors. */
        fun phi(a: BooleanArray, b: BooleanArray): Double {
            var n11 = 0.0; var n10 = 0.0; var n01 = 0.0; var n00 = 0.0
            for (i in a.indices) when {
                a[i] && b[i] -> n11++
                a[i] -> n10++
                b[i] -> n01++
                else -> n00++
            }
            val den = kotlin.math.sqrt((n11 + n10) * (n01 + n00) * (n11 + n01) * (n10 + n00))
            return if (den > 0) (n11 * n00 - n10 * n01) / den else 0.0
        }
    }
}
