// What the sky (Mars Sky) and the night-sky overlays (Mars Stars, Mars Constellation Lines) share: the sky globals
// DayNightCycle and MarsAtmosphere publish, the celestial frame, the far-plane projection of a direction, and the
// extinction of starlight through the Martian air.
//
// Needs URP's Core.hlsl (UNITY_MATRIX_VP, UNITY_REVERSED_Z); it is included here and include-guarded, so including
// it first in the shader as well costs nothing.
#ifndef MARS_SKY_COMMON_INCLUDED
#define MARS_SKY_COMMON_INCLUDED

#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"

// Globals, outside any CBUFFER (set from C#, never per material).
float4x4 _MarsCelestial; // DayNightCycle: world -> ICRF (J2000 equator), rotation part only; improper (det -1), so
                         // never treat it as a quaternion. Its transpose maps ICRF back to world.
float _MarsStars;        // DayNightCycle: 0 by day .. 1 at full night, dimmed by extra dust (the Milky Way uses it)
float _MarsSkyDark;      // DayNightCycle: 0 by day .. 1 at full night, no dust term (the star points' limiting magnitude)
float4 _MarsDust;        // MarsAtmosphere: x dust optical depth above the clear sky (>= 0), y storm amount, z local dust, w gust
float4 _MarsSunDir;      // DayNightCycle: xyz unit vector toward the sun (world)

// Dust optical depth of the clear sky: MarsWeather.clearOpticalDepth's default. Gale's clear-season tau is about
// 0.4-0.6 (Mastcam solar imaging); _MarsDust.x is what the weather adds on top of it.
static const float MarsClearTau = 0.5;

// Row-vector multiply = the transpose: ICRF -> world.
float3 MarsIcrfToWorld(float3 icrf)
{
    return mul(icrf, (float3x3)_MarsCelestial);
}

float3 MarsWorldToIcrf(float3 dirWS)
{
    return mul((float3x3)_MarsCelestial, dirWS);
}

// Clip position of a direction at infinity: w = 0 drops the camera's translation, so the sky turns with the view
// but never moves with the player. Depth is put exactly on the far plane, so it never clips against it and
// anything the camera has drawn (terrain, Mount Sharp) hides it under ZTest LEqual, like the skybox.
float4 MarsSkyClip(float3 dirWS)
{
    float4 clip = mul(UNITY_MATRIX_VP, float4(dirWS, 0.0));
#if UNITY_REVERSED_Z
    clip.z = 0.0;
#else
    clip.z = clip.w;
#endif
    return clip;
}

// Transmission of starlight toward a direction whose elevation has sine sinElevation, RELATIVE TO THE CLEAR-SKY
// ZENITH: the catalogue's magnitudes are above any atmosphere, and the clear zenith's own loss (tau 0.5, about
// 0.5 mag) is folded into the artistic brightness. So the clear sky only dims by the extra air masses toward the
// horizon, while dust above the clear sky (_MarsDust.x) dims every direction, the zenith included.
// Beer-Lambert over a plane-parallel air mass 1/sin(elevation) (as rovers measure tau from the sun's dimming;
// Lemmon et al. 2015). The cap of 33 air masses (1.7 degrees up) only avoids the singularity: the real air mass at
// the horizon is about sqrt(pi R / 2H) = 22 for Mars's ~11 km scale height (derived), and at either value a clear
// sky's star is gone (< 1e-4).
// Fades smoothly to 0 just below the horizon line.
float MarsExtinction(float sinElevation)
{
    float dust = max(_MarsDust.x, 0.0);
    float airmass = 1.0 / max(sinElevation, 0.03);
    return exp(-(MarsClearTau + dust) * (airmass - 1.0)) * exp(-dust) * smoothstep(-0.01, 0.0, sinElevation);
}

#endif // MARS_SKY_COMMON_INCLUDED
