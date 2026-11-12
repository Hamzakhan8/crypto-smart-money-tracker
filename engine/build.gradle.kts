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

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("failed")
        exceptionFormat = org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL
    }
}
