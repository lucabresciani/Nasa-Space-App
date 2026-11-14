// Procedural Mars sky for the day/night cycle: butterscotch haze by day, a blue glow around the
// setting sun, stars at night. Sun position and sky colours come from DayNightCycle as globals,
// so the material itself only holds the look of the sun, the stars and the ice clouds.
//
// Weather (MarsWeather, through MarsAtmosphere) adds dust and water-ice clouds via _MarsDust, _MarsWind and
// _MarsCloud. All three are 0 in clear weather, and every weather term then reduces to the clear-sky maths
// (x1, +0 or lerp(..., 0)), so without weather the sky is exactly what it was. No keywords: uniform branches only.
Shader "NasaSpaceApp/Mars Sky"
{
    Properties
    {
        [Header(Sun)]
        _SunSize ("Sun Disk Radius (degrees)", Range(0.1, 2)) = 0.45
        _SunBrightness ("Sun Disk Brightness (HDR)", Range(1, 20)) = 3
        _GlowColor ("Haze Glow", Color) = (0.95, 0.85, 0.70, 1)
        _AureoleColor ("Blue Aureole, Sun High", Color) = (0.78, 0.84, 0.92, 1)
        _SunsetColor ("Blue Aureole, Sun Low", Color) = (0.45, 0.62, 0.86, 1)

        [Header(Stars)]
        _StarGrid ("Star Grid (cells per cube face)", Range(40, 400)) = 180
        _StarChance ("Chance of a Star per Cell", Range(0, 0.25)) = 0.04
        _StarBrightness ("Star Brightness", Range(0, 8)) = 2

        [Header(Water Ice Clouds)]
        _CloudColor ("Sunlit Ice Cloud Colour", Color) = (0.90, 0.92, 0.95, 1)
        _CloudScale ("Cloud Noise Cells per km", Range(0.01, 0.3)) = 0.06
    }

    SubShader
    {
        Tags { "Queue" = "Background" "RenderType" = "Background" "PreviewType" = "Skybox" "RenderPipeline" = "UniversalPipeline" }
        Cull Off
        ZWrite Off

        Pass
        {
            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Packages/com.unity.render-pipelines.core/ShaderLibrary/Color.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float _SunSize;
                float _SunBrightness;
                float4 _GlowColor;
                float4 _AureoleColor;
                float4 _SunsetColor;
                float _StarGrid;
                float _StarChance;
                float _StarBrightness;
                float4 _CloudColor;
                float _CloudScale;
            CBUFFER_END

            // Set by DayNightCycle. Sky colours arrive in gamma space.
            float4 _MarsSunDir;      // xyz: unit vector toward the sun
            float4 _MarsSkyHorizon;
            float4 _MarsSkyZenith;
            float _MarsStars;        // 0 by day .. 1 at full night
            float4x4 _MarsCelestial; // world -> star field, so the stars turn with the sun

            // Set by MarsAtmosphere (the weather). All zero = clear.
            float4 _MarsDust;  // x: dust optical depth above the clear sky (>= 0), y: storm amount, z: local dust, w: gust
            float4 _MarsWind;  // xy: wind in m/s on world X/Z (where the air goes), z: speed, w: weather clock (s)
            float4 _MarsCloud; // xy: how far the clouds have drifted, km on world X/Z (never wrapped), z: cover 0..1, w: altitude (km)

            // Thin water-ice clouds stay translucent (optical depth about 0.1-0.3 is a rough estimate): this caps
            // their opacity. Artistic, not a measurement.
            static const float CloudOpacity = 0.55;
            static const float MarsRadiusKm = 3389.5; // mean radius
            static const float2x2 OctaveTurn = float2x2(0.8, -0.6, 0.6, 0.8); // breaks up the grid between octaves

            struct Attributes
            {
                float4 positionOS : POSITION;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 direction : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings Vert(Attributes input)
            {
                Varyings output;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);
                output.positionCS = TransformObjectToHClip(input.positionOS.xyz);
                output.direction = input.positionOS.xyz;
                return output;
            }

            // Material colours are uploaded in linear space; the sky is blended in gamma space.
            float3 Authored(float4 color)
            {
            #if defined(UNITY_COLORSPACE_GAMMA)
                return color.rgb;
            #else
                return LinearToSRGB(color.rgb);
            #endif
            }

            // PCG3D integer hash: no visible lines or streaks across neighbouring cells.
            float3 Random3(float2 cell, float face)
            {
                uint3 v = uint3(int3(int2(cell), int(face)));
                v = v * 1664525u + 1013904223u;
                v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
                v ^= v >> 16u;
                v.x += v.y * v.z; v.y += v.z * v.x; v.z += v.x * v.y;
                return float3(v) * (1.0 / 4294967296.0);
            }

            // One candidate star per cell of an equi-angular cube grid. Stars sit away from the cell edges,
            // so one lookup per pixel is enough, and are drawn about a pixel wide at any resolution.
            float3 Stars(float3 d, float pixelAngle)
            {
                float3 a = abs(d);
                float2 uv;
                float face;
                if (a.x >= a.y && a.x >= a.z) { uv = d.yz / a.x; face = d.x > 0 ? 1 : 2; }
                else if (a.y >= a.z)          { uv = d.xz / a.y; face = d.y > 0 ? 3 : 4; }
                else                          { uv = d.xy / a.z; face = d.z > 0 ? 5 : 6; }

                float2 grid = (atan(uv) * (2.0 / PI) + 0.5) * _StarGrid;
                float2 cell = floor(grid);
                float3 h = Random3(cell, face);
                if (h.z > _StarChance) return 0;

                float3 h2 = Random3(cell, face + 8.0);
                float magnitude = h2.x * h2.x * h2.x * h2.x;       // a few bright stars, many faint ones
                float pixel = pixelAngle * _StarGrid / (PI * 0.5); // pixel footprint, in cells
                float radius = min(pixel * lerp(0.9, 1.8, magnitude), 0.3);
                float2 center = cell + 0.3 + 0.4 * h.xy;
                float core = saturate(1.0 - length(grid - center) / radius);
                float3 tint = lerp(float3(1.0, 0.8, 0.62), float3(0.72, 0.84, 1.0), h2.y);
                return tint * (core * core * lerp(0.06, 3.0, magnitude));
            }

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

            half4 Frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);
                float3 dir = normalize(input.direction);
                float pixelAngle = length(fwidth(dir)); // outside every branch: derivatives need the whole pixel quad
                float3 toSun = _MarsSunDir.xyz;
                float sunHeight = toSun.y;                             // sine of the sun's elevation
                float low = 1.0 - smoothstep(0.0, 0.35, sunHeight);    // 0 sun high .. 1 sun on the horizon
                float lingering = smoothstep(-0.3, 0.02, sunHeight);   // the twilight glow outlasts the sun

                // Dust above the clear sky (0 when clear). Mars dust scatters strongly forward (asymmetry g about
                // 0.6-0.7; Tomasko et al. 1999, Pathfinder), so in dust the light around the sun spreads: the tight
                // aureole becomes a broad, bright smear. How fast it spreads with tau is an artistic estimate.
                float dust = max(_MarsDust.x, 0.0);
                float spread = saturate(dust / 3.0);

                // Butterscotch gradient (gamma space, the same maths as the old baked sky).
                float3 horizon = _MarsSkyHorizon.rgb;
                float3 c = lerp(horizon, _MarsSkyZenith.rgb, pow(saturate(dir.y), 0.45));
                c = lerp(c, horizon * 0.8, saturate(-dir.y * 4.0));

                float cosSun = dot(dir, toSun);
                float toward = saturate(cosSun);
                // pow(x, 6.0) compiles to multiplications and a variable exponent to exp2/log2, which differ by a few
                // ULPs: without dust keep the clear sky's own instructions, so it stays bit-identical.
                float glow = spread > 0.0 ? pow(toward, lerp(6.0, 2.5, spread)) * (1.0 + 0.6 * spread) : pow(toward, 6.0);
                c += Authored(_GlowColor) * (glow * 0.22 * lingering);

                // Mars's blue aureole: a tight halo while the sun is high, a wide blue glow as it sets. Dust widens
                // it and washes it out.
                float3 sunset = Authored(_SunsetColor) * lerp(0.3, 1.0, smoothstep(-0.2, 0.05, sunHeight));
                float aureole = pow(toward, lerp(lerp(140.0, 12.0, low), 6.0, 0.7 * spread)) * lerp(0.6, 0.85, low) * lingering;
                aureole *= lerp(1.0, 0.6, spread);
                c = lerp(c, lerp(Authored(_AureoleColor), sunset, low), aureole);

                // Water-ice clouds. Curiosity images them about 50 km up and sees them glow after sunset; most Martian
                // clouds are water ice below about 60 km. A flat deck at _MarsCloud.w km, skipped entirely when clear.
                float cloud = 0.0; // opacity of the deck in this direction
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
                    float2 p = float2(dot(deck, axis) * (1.0 / 3.0), dot(deck, float2(-axis.y, axis.x))) * _CloudScale;

                    // The projection stretches by 1/rise^2 toward the horizon: octave-0 cells per pixel there.
                    float pixelCells = _CloudScale * altitude * pixelAngle / (rise * rise);
                    float cover = saturate(_MarsCloud.z);
                    cloud = saturate((CloudNoise(p, pixelCells) - (1.0 - cover)) * 3.0) * smoothstep(0.015, 0.12, dir.y);

                    // A deck H km up stays sunlit until the sun is acos(R / (R + H)) below the horizon: 9.8 degrees
                    // (sine 0.17) for 50 km, so the clouds keep glowing over the darkening sky (derived geometry).
                    float k = MarsRadiusKm / (MarsRadiusKm + altitude);
                    float dip = sqrt(1.0 - k * k);
                    float lit = smoothstep(-dip, 0.12 - dip, sunHeight);
                    // Ice scatters forward, so the deck brightens toward the sun.
                    float3 sunlit = Authored(_CloudColor) * lerp(1.0, 0.8, low) * (1.0 + 0.5 * pow(toward, 8.0));
                    // At night the deck catches the scene's night light (opposite the sun, like a full moon) and reads as
                    // a faint silver-blue veil against the stars instead of vanishing. Artistic: Phobos is far dimmer.
                    float moonUp = smoothstep(0.05, 0.3, -sunHeight);
                    float towardMoon = saturate(dot(dir, -toSun));
                    float3 moonlit = float3(0.14, 0.15, 0.19) * moonUp * (1.0 + 0.6 * pow(towardMoon, 8.0));
                    float3 cloudColor = lerp(max(c * 0.85, moonlit), sunlit, lit);

                    // Thinnest around noon (EMM EXI sees the aphelion clouds' daily minimum near noon; the 0.6 is an
                    // estimate), and seen through the extra dust below the deck: Beer-Lambert over 1/sin(elevation).
                    cloud *= CloudOpacity * lerp(0.6, 1.0, low) * exp(-dust / max(dir.y, 0.05));
                    c = lerp(c, cloudColor, cloud);
                }

                // Sun disk, hidden once it sinks below the horizon line. Beer-Lambert dims it through the extra dust
                // (1/sin(elevation) air masses, as rovers measure tau by imaging the sun; Lemmon et al. 2015), and a
                // cloud in front veils it.
                float angle = degrees(acos(clamp(cosSun, -1.0, 1.0)));
                float disk = smoothstep(_SunSize * 1.35, _SunSize * 0.8, angle) * smoothstep(-0.01, 0.0, dir.y);
                disk *= exp(-dust / max(sunHeight, 0.03)) * (1.0 - 0.6 * cloud);
                c = lerp(c, 1.0, disk);

                // Half a gamma step of dither so the dark night gradient doesn't band.
                float noise = frac(52.9829189 * frac(dot(input.positionCS.xy, float2(0.06711056, 0.00583715))));
                c += (noise - 0.5) / 255.0;

                float3 color = SRGBToLinear(max(c, 0.0));
                color += disk * (_SunBrightness - 1.0); // HDR, so the sun catches a little bloom

                if (_MarsStars > 0.0)
                {
                    float3 starDir = mul((float3x3)_MarsCelestial, dir);
                    color += Stars(starDir, pixelAngle) * (_StarBrightness * _MarsStars * smoothstep(0.0, 0.2, dir.y) * (1.0 - cloud));
                }
                return half4(color, 1.0);
            }
            ENDHLSL
        }
    }
    Fallback Off
}
