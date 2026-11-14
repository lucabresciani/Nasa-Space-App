// The weather's water-ice cloud deck, shared by the sky (Mars Sky) and the night-sky points (Mars Stars), so a star
// disappears behind exactly the cloud the sky draws in front of it. Moved here unchanged from MarsSky.shader: the
// sky's output is bit for bit what it was (same operations in the same order).
//
// Self-contained: intrinsics only, no URP include needed. Globals sit outside any CBUFFER (set from C#).
#ifndef MARS_CLOUDS_INCLUDED
#define MARS_CLOUDS_INCLUDED

// Set by MarsAtmosphere (the weather). All zero = clear.
float4 _MarsWind;  // xy: wind in m/s on world X/Z (where the air goes), z: speed, w: weather clock (s)
float4 _MarsCloud; // xy: how far the clouds have drifted, km on world X/Z (never wrapped), z: cover 0..1, w: altitude (km)

// Thin water-ice clouds stay translucent (optical depth about 0.1-0.3 is a rough estimate): this caps
// their opacity. Artistic, not a measurement.
static const float CloudOpacity = 0.55;
static const float2x2 OctaveTurn = float2x2(0.8, -0.6, 0.6, 0.8); // breaks up the grid between octaves

// lowbias32 integer hash (C. Wellons) -> [0, 1). Integer maths stays exact at the large, never-wrapped
// coordinates of the drifting cloud deck, where sin()-based hashes break up into stripes.
float CloudHash(int2 cell, uint octave)
{
    uint2 v = asuint(cell);
    uint h = v.x * 0x8DA6B343u ^ v.y * 0xD8163841u ^ octave * 0xCB1AB31Fu;
    h ^= h >> 16;
    h *= 0x7FEB352Du;
    h ^= h >> 15;
    h *= 0x846CA68Bu;
    h ^= h >> 16;
    return float(h >> 8) * (1.0 / 16777216.0);
}

float ValueNoise(float2 p, uint octave)
{
    float2 i = floor(p);
    float2 f = p - i;
    float2 u = f * f * (3.0 - 2.0 * f);
    int2 cell = int2(i);
    float a = CloudHash(cell, octave);
    float b = CloudHash(cell + int2(1, 0), octave);
    float c = CloudHash(cell + int2(0, 1), octave);
    float d = CloudHash(cell + int2(1, 1), octave);
    return lerp(lerp(a, b, u.x), lerp(c, d, u.x), u.y);
}

// Three octaves of value noise, 0..1. An octave whose cells shrink toward a pixel fades to its mean
// (pixelCells = octave-0 cells per pixel), so the far deck near the horizon doesn't shimmer as it drifts.
// The sum clusters around 0.5 (sd 0.14); doubling its contrast spreads it to about uniform (sd 0.28), so a
// cover of 0.7 really puts cloud over about 70% of the sky (measured offline on 40k samples).
float CloudNoise(float2 p, float pixelCells)
{
    float sum = 0.0;
    float amplitude = 0.5;
    [unroll] for (uint octave = 0u; octave < 3u; octave++)
    {
        float keep = saturate(1.5 - 2.0 * pixelCells); // full below 1/4 cell per pixel, gone at 3/4
        sum += amplitude * lerp(0.5, ValueNoise(p, octave), keep);
        p = mul(OctaveTurn, p) * 2.0 + 19.19;
        pixelCells *= 2.0;
        amplitude *= 0.5;
    }
    return saturate((sum * (1.0 / 0.875) - 0.5) * 2.0 + 0.5);
}

// Water-ice clouds. Curiosity images them about 50 km up and sees them glow after sunset; most Martian
// clouds are water ice below about 60 km. A flat deck at _MarsCloud.w km, skipped entirely when clear.
//
// Returns how much of the deck covers the unit world direction dir, 0..1, before CloudOpacity, the noon thinning
// and the dust in front of it (the caller applies those). pixelAngle: radians per pixel there (the sky passes
// length(fwidth(dir)), a vertex shader the camera's 1 / pixels-per-radian). cloudScale: noise cells per km (the
// sky material's _CloudScale). The branch on _MarsCloud.z is uniform; no derivatives are taken in here.
float MarsCloudCover(float3 dir, float pixelAngle, float cloudScale)
{
    float cloud = 0.0;
    if (_MarsCloud.z > 0.001)
    {
        float altitude = max(_MarsCloud.w, 1.0);
        float rise = max(dir.y, 0.015);
        // Where the view ray meets the deck, in km from the observer, minus how far the clouds have drifted:
        // the air seen here now came from upwind.
        float2 deck = dir.xz * (altitude / rise) - _MarsCloud.xy;

        // Wisps stretched 3:1 along the wind. The axis follows the drift so far (the integral of the mean
        // wind) plus a little of the current wind, which sets it before anything has drifted. Turning the
        // noise with the gusty wind itself would pivot it about the far-away drifted origin and swing the
        // whole deck by |drift| x angle on every gust; this way a change of wind turns it at drift speed.
        float2 axis = _MarsCloud.xy + 0.05 * _MarsWind.xy + float2(0.0, 1e-4);
        axis *= rsqrt(dot(axis, axis));
        float2 p = float2(dot(deck, axis) * (1.0 / 3.0), dot(deck, float2(-axis.y, axis.x))) * cloudScale;

        // The projection stretches by 1/rise^2 toward the horizon: octave-0 cells per pixel there.
        float pixelCells = cloudScale * altitude * pixelAngle / (rise * rise);
        float cover = saturate(_MarsCloud.z);
        cloud = saturate((CloudNoise(p, pixelCells) - (1.0 - cover)) * 3.0) * smoothstep(0.015, 0.12, dir.y);
    }
    return cloud;
}

#endif // MARS_CLOUDS_INCLUDED
