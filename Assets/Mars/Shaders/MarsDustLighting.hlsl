// Shared lighting for the weather's dust: the particles (Mars Dust Particle) and the dust devils (Mars Dust Devil).
// Dust is lit by DayNightCycle's ambient colour plus the main light scattered forward by the grains, fades softly
// where it meets the ground (depth texture), and gets URP's fog like every other surface.
//
// Include it AFTER #include_with_pragmas ".../ShaderLibrary/Fog.hlsl", which declares the fog keywords MixFog needs.
#ifndef MARS_DUST_LIGHTING_INCLUDED
#define MARS_DUST_LIGHTING_INCLUDED

#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Lighting.hlsl"
#include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/DeclareDepthTexture.hlsl"

// Globals, outside any CBUFFER (like MarsSky's). Zero means clear weather.
float4 _MarsAmbient; // DayNightCycle: LINEAR (ambientSky + ambientEquator) / 2 after the weather modifiers, alpha 1
float4 _MarsWind;    // MarsWeather: xy wind in m/s on world X/Z (where the air goes), z speed m/s, w weather clock s
float4 _MarsDust;    // MarsWeather: x extra optical depth, y storm amount, z local dust, w gust

// How much of the main light the dust sends toward the eye. Artistic, not measured: an optically thin dust layer
// would return about 0.25 of it (derived from single scattering), but brighter dust reads better against the sky.
#define MARS_DUST_SUN_SHARE 0.6
// Cap on the phase function. The true Henyey-Greenstein forward peak at g = 0.6 is 10x the average; capped, the
// phase spans 0.16 (back) to 2.5 (toward the sun), so sunlit dust glows without blowing out into bloom. Artistic.
#define MARS_DUST_PHASE_MAX 2.5

// Henyey-Greenstein phase function, scaled by 4 pi so that it averages 1 over the sphere (before the cap).
// Mars dust scatters strongly forward, asymmetry g ~ 0.6-0.7 in the visible (Tomasko et al. 1999, JGR, Pathfinder),
// so dust looks brightest when you look toward the sun.
// cosTheta = 1 when the eye looks straight at the light through the dust.
float MarsDustPhase(float cosTheta, float g)
{
    float g2 = g * g;
    float denominator = max(1.0 + g2 - 2.0 * g * cosTheta, 1e-4);
    float phase = (1.0 - g2) / (denominator * sqrt(denominator));
    return min(phase, MARS_DUST_PHASE_MAX);
}

// Light the dust at positionWS sends to the eye: ambient from every side, plus the main light by its phase.
// distanceAttenuation is deliberately NOT used: in Forward+ (the PC renderer) URP does not fill unity_LightData,
// which that value comes from, so it can read 0. The main light is directional and never attenuated anyway.
// Night is handled for free: DayNightCycle turns the same light into the faint night light, or switches it off.
float3 MarsDustLight(float3 positionWS, float g)
{
    Light mainLight = GetMainLight();
    float3 eyeToDust = SafeNormalize(positionWS - _WorldSpaceCameraPos.xyz);
    float cosTheta = dot(eyeToDust, float3(mainLight.direction));
    return _MarsAmbient.rgb + float3(mainLight.color) * (MarsDustPhase(cosTheta, g) * MARS_DUST_SUN_SHARE);
}

// Same homogeneous screen position URP computes in GetVertexPositionInputs (positionNDC), from a clip position.
float4 MarsScreenPosition(float4 positionCS)
{
    float4 ndc = positionCS * 0.5;
    float4 screen;
    screen.xy = float2(ndc.x, ndc.y * _ProjectionParams.x) + ndc.w;
    screen.zw = positionCS.zw;
    return screen;
}

// 0 where the dust touches the scene behind it, 1 once it is fadeDistance metres in front, so grains and sheets
// melt into the ground instead of cutting a hard line. Needs the camera depth texture (PC_RPAsset requires it).
// Callers skip this with a uniform branch when fadeDistance is 0: the no-depth path for renderers without it.
float MarsSoftDepthFade(float4 screenPosition, float eyeDepth, float fadeDistance)
{
    float2 uv = screenPosition.xy / screenPosition.w;
    float rawDepth = SampleSceneDepth(uv);
    float sceneDepth = unity_OrthoParams.w == 0.0 ? LinearEyeDepth(rawDepth, _ZBufferParams) : LinearDepthToEyeDepth(rawDepth);
    return saturate((sceneDepth - eyeDepth) / fadeDistance);
}

// URP's per-fragment fog factor (as InitializeInputDataFog computes it), from the view depth we already have.
float MarsFogFactor(float eyeDepth)
{
    return ComputeFogFactorZ0ToFar(max(eyeDepth - _ProjectionParams.y, 0.0));
}

#endif // MARS_DUST_LIGHTING_INCLUDED
