package com.smartmoney.screener.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

object Palette {
    val Bg = Color(0xFF0E1116)
    val Surface = Color(0xFF161B22)
    val SurfaceHigh = Color(0xFF1F2630)
    val Text = Color(0xFFE6EDF3)
    val Muted = Color(0xFF9DA7B3)
    val Up = Color(0xFF3DDC97)
    val Down = Color(0xFFFF6B6B)
    val Amber = Color(0xFFFFB547)
    val Off = Color(0xFF5C6670)
    val Blue = Color(0xFF6CB6FF)
}

private val scheme = darkColorScheme(
    primary = Palette.Up,
    onPrimary = Color(0xFF00281A),
    secondary = Palette.Amber,
    onSecondary = Color(0xFF2B1A00),
    tertiary = Palette.Blue,
    background = Palette.Bg,
    onBackground = Palette.Text,
    surface = Palette.Surface,
    onSurface = Palette.Text,
    surfaceVariant = Palette.SurfaceHigh,
    onSurfaceVariant = Palette.Muted,
    surfaceContainer = Palette.Surface,
    surfaceContainerHigh = Palette.SurfaceHigh,
    surfaceContainerLow = Palette.Surface,
    error = Palette.Down,
    outline = Color(0xFF3A434E),
    outlineVariant = Color(0xFF2A313A),
)

@Composable
fun SmartMoneyTheme(content: @Composable () -> Unit) {
    MaterialTheme(colorScheme = scheme, typography = Typography(), content = content)
}
