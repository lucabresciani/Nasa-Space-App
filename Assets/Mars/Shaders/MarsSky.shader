// Procedural Mars sky for the day/night cycle: butterscotch haze by day, a blue glow around the
// setting sun, stars at night. Sun position and sky colours come from DayNightCycle as globals,
// so the material itself only holds the look of the sun and the stars.
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
            CBUFFER_END

            // Set by DayNightCycle. Sky colours arrive in gamma space.
            float4 _MarsSunDir;      // xyz: unit vector toward the sun
            float4 _MarsSkyHorizon;
            float4 _MarsSkyZenith;
            float _MarsStars;        // 0 by day .. 1 at full night
            float4x4 _MarsCelestial; // world -> star field, so the stars turn with the sun

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

            half4 Frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);
                float3 dir = normalize(input.direction);
                float3 toSun = _MarsSunDir.xyz;
                float sunHeight = toSun.y;                             // sine of the sun's elevation
                float low = 1.0 - smoothstep(0.0, 0.35, sunHeight);    // 0 sun high .. 1 sun on the horizon
                float lingering = smoothstep(-0.3, 0.02, sunHeight);   // the twilight glow outlasts the sun

                // Butterscotch gradient (gamma space, the same maths as the old baked sky).
                float3 horizon = _MarsSkyHorizon.rgb;
                float3 c = lerp(horizon, _MarsSkyZenith.rgb, pow(saturate(dir.y), 0.45));
                c = lerp(c, horizon * 0.8, saturate(-dir.y * 4.0));

                float cosSun = dot(dir, toSun);
                float toward = saturate(cosSun);
                c += Authored(_GlowColor) * (pow(toward, 6.0) * 0.22 * lingering);

                // Mars's blue aureole: a tight halo while the sun is high, a wide blue glow as it sets.
                float3 sunset = Authored(_SunsetColor) * lerp(0.3, 1.0, smoothstep(-0.2, 0.05, sunHeight));
                float aureole = pow(toward, lerp(140.0, 12.0, low)) * lerp(0.6, 0.85, low) * lingering;
                c = lerp(c, lerp(Authored(_AureoleColor), sunset, low), aureole);

                // Sun disk, hidden once it sinks below the horizon line.
                float angle = degrees(acos(clamp(cosSun, -1.0, 1.0)));
                float disk = smoothstep(_SunSize * 1.35, _SunSize * 0.8, angle) * smoothstep(-0.01, 0.0, dir.y);
                c = lerp(c, 1.0, disk);

                // Half a gamma step of dither so the dark night gradient doesn't band.
                float noise = frac(52.9829189 * frac(dot(input.positionCS.xy, float2(0.06711056, 0.00583715))));
                c += (noise - 0.5) / 255.0;

                float3 color = SRGBToLinear(max(c, 0.0));
                color += disk * (_SunBrightness - 1.0); // HDR, so the sun catches a little bloom

                float pixelAngle = length(fwidth(dir));
                if (_MarsStars > 0.0)
                {
                    float3 starDir = mul((float3x3)_MarsCelestial, dir);
                    color += Stars(starDir, pixelAngle) * (_StarBrightness * _MarsStars * smoothstep(0.0, 0.2, dir.y));
                }
                return half4(color, 1.0);
            }
            ENDHLSL
        }
    }
    Fallback Off
}
