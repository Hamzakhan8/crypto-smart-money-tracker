// Smart Money Screener engine: pure Kotlin/JVM, no Android dependencies.
// Models, exchange adapters (Binance, Bybit, OKX; public data only), connection managers, features and the screener.
plugins {
    id("org.jetbrains.kotlin.jvm")
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-core:1.9.0")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.9.0")
}

// Live check against the real exchanges (needs internet; not part of `test`):
//   ./gradlew :engine:liveSmoke -Pminutes=3 -Ptf=1m
tasks.register<JavaExec>("liveSmoke") {
    group = "verification"
    description = "Runs the real engine against Binance, Bybit and OKX for a few minutes and prints what it sees."
    classpath = sourceSets["test"].runtimeClasspath
    mainClass.set("com.smartmoney.engine.LiveSmokeKt")
    args = listOf((project.findProperty("minutes") ?: "3").toString(), (project.findProperty("tf") ?: "1m").toString())
}

// Phase 3 Replay Lab: one command reproduces the pre-registered baseline results with receipts
// (downloads and verifies the Binance archive into engine/replay-cache on the first run):
//   ./gradlew :engine:replayLab
tasks.register<JavaExec>("replayLab") {
    group = "verification"
    description = "Replays the pre-registered baselines and placebos of docs/experiments.md on real Binance archive data."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.smartmoney.engine.replay.ReplayLabMainKt")
    maxHeapSize = "4g"
    val repo = project.projectDir.parentFile
    args = listOf(
        "--repo", repo.absolutePath,
        "--cache", File(project.projectDir, "replay-cache").absolutePath,
        "--command", "./gradlew :engine:replayLab",
    )
}

// v0.3 signal research (docs/experiments.md E006), development stage: ./gradlew :engine:replayV03
tasks.register<JavaExec>("replayV03") {
    group = "verification"
    description = "Runs the pre-registered v0.3 research (train 2025, validation 2026Q1) on the Binance archive."
    classpath = sourceSets["main"].runtimeClasspath
    mainClass.set("com.smartmoney.engine.replay.v03.V03MainKt")
    maxHeapSize = "6g"
    val repo = project.projectDir.parentFile
    args = listOf(
        "--repo", repo.absolutePath,
        "--cache", File(project.projectDir, "replay-cache").absolutePath,
        "--command", "./gradlew :engine:replayV03",
    )
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
