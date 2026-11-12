pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "SmartMoneyScreener"

include(":app")

// The engine is plain Kotlin/JVM with no Android dependencies. It lives in ../engine and is built as part of this build,
// so `./gradlew :engine:test` runs its tests and `./gradlew assembleDebug` builds the app that uses it.
include(":engine")
project(":engine").projectDir = file("../engine")
