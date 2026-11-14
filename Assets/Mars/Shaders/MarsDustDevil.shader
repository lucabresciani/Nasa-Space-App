// A dust devil column: the procedural DustDevilColumn funnel (unit height, radius 0.5 at the base to 1.0 at the top,
// u = angle / 2pi, v = height, outward normals) drawn as a translucent, swirling dust volume.
//
// Per devil, DustDevilField sets a MaterialPropertyBlock: _DevilParams = (opacity, spin in rev/s (signed), height m,
// seed 0..1) and _DevilRadius (base radius, m). The object transform carries the size (diameter, height, diameter).
//
// Looks: two octaves of procedural noise wrap around the column and scroll with the spin (u) and the updraft (v);
// the silhouette fades by |N.V| so the edges look soft and volumetric; the column fades in at the ground (soft depth
// fade) and out at the top; it is lit like the dust particles and fogged. When the camera gets within about a radius
// of the axis the column fades out, so a close pass never becomes a full-screen wall; the local dust takes over.
Shader "NasaSpaceApp/Mars Dust Devil"
{
    Properties
    {
        // Shown sRGB-encoded: Unity converts it to linear (1.32, 0.81, 0.47) on upload. The setup writes the same value.
        [HDR] _BaseColor ("Dust Colour (linear multiplier; alpha = peak opacity)", Color) = (1.131, 0.912, 0.717, 0.35)
        _NoiseScale ("Noise Scale (x: cells around, rounded; y: cells up the column)", Vector) = (6, 9, 0, 0)
        _SoftFade ("Soft Depth Fade At The Ground (metres; 0 = off, no depth texture)", Float) = 2
        _Phase ("Forward Scattering g (Henyey-Greenstein)", Range(0, 0.9)) = 0.6
        [HideInInspector] _DevilParams ("Devil (opacity, spin rev/s, height m, seed)", Vector) = (1, 0.2, 150, 0)
        [HideInInspector] _DevilRadius ("Devil Base Radius (m)", Float) = 11
    }

    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" "IgnoreProjector" = "True" "RenderPipeline" = "UniversalPipeline" }

        Pass
        {
            Name "DustDevil"
            Tags { "LightMode" = "UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Off // the far wall shows through the near one: a denser core, like a real dust column

            HLSLPROGRAM
            #pragma target 3.5
            #pragma vertex Vert
            #pragma fragment Frag

            #include_with_pragmas "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Fog.hlsl"
            #include "MarsDustLighting.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseColor;
                float4 _NoiseScale;
                float _SoftFade;
                float _Phase;
                float4 _DevilParams;
                float _DevilRadius;
            CBUFFER_END

            // Shape constants. Artistic: they make the column read as a vortex, nothing here is measured.
            #define DEVIL_LEAN_PER_HEIGHT 0.02   // the top leans downwind by up to 2% of the height (full at 15 m/s)
            #define DEVIL_LEAN_FULL_WIND 15.0
            #define DEVIL_SWAY_PER_HEIGHT 0.012  // slow wobble of the upper column
            #define DEVIL_TWIST 0.35             // turns of helix from base to top, so the streaks spiral
            #define DEVIL_RISE_PER_SECOND 0.03   // the noise climbs 3% of the column per second (contract)
            #define DEVIL_WRAP_UP 64.0           // vertical noise period in cells: the climb wraps without a seam

            struct Attributes
            {
                float4 positionOS : POSITION;
                float3 normalOS : NORMAL;
                float2 uv : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                float3 normalWS : TEXCOORD1;
                float3 positionWS : TEXCOORD2;
                float4 screenPosition : TEXCOORD3;
                float4 color : TEXCOORD4; // rgb: lit colour, a: opacity x close-pass fade
                float eyeDepth : TEXCOORD5;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings Vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);

                float v = input.uv.y;
                float height = _DevilParams.z;
                float seedAngle = _DevilParams.w * 6.2831853;
                float clock = _MarsWind.w;
                float3 positionWS = TransformObjectToWorld(input.positionOS.xyz);

                // Lean the upper column downwind (faster wind aloft), plus a slow sway of its own (~30 s and ~48 s).
                float speed = _MarsWind.z;
                float2 downwind = speed > 1e-3 ? _MarsWind.xy / speed : float2(0.0, 0.0);
                float lean = pow(v, 1.5) * height * DEVIL_LEAN_PER_HEIGHT * min(speed, DEVIL_LEAN_FULL_WIND) / DEVIL_LEAN_FULL_WIND;
                float2 sway = float2(sin(clock * 0.21 + seedAngle), sin(clock * 0.13 + seedAngle * 1.7)) * (v * v * height * DEVIL_SWAY_PER_HEIGHT);
                positionWS.xz += downwind * lean + sway;

                output.positionCS = TransformWorldToHClip(positionWS);
                output.screenPosition = MarsScreenPosition(output.positionCS);
                output.eyeDepth = -TransformWorldToView(positionWS).z;
                output.positionWS = positionWS;
                output.normalWS = TransformObjectToWorldNormal(input.normalOS);
                output.uv = input.uv;

                // Close pass: fade with the camera's horizontal distance to the axis, from 2.3 r down to 0.8 r.
                float3 axisWS = TransformObjectToWorld(float3(0.0, 0.0, 0.0));
                float toAxis = length(_WorldSpaceCameraPos.xz - axisWS.xz);
                float radius = max(_DevilRadius, 0.5);
                float closeFade = saturate((toAxis - 0.8 * radius) / (1.5 * radius));

                float3 light = MarsDustLight(positionWS, _Phase);
                output.color = float4(_BaseColor.rgb * light, _BaseColor.a * saturate(_DevilParams.x) * closeFade);
                return output;
            }

            // Integer hash of a lattice cell -> [0, 1). No sine hashing: stable on every GPU.
            float MarsCellHash(float2 cell, uint seed)
            {
                uint2 q = uint2(int2(cell));
                uint h = q.x * 0x8DA6B343u ^ q.y * 0xD8163841u ^ seed * 0xCB1AB31Fu;
                h ^= h >> 16;
                h *= 0x7FEB352Du;
                h ^= h >> 15;
                h *= 0x846CA68Bu;
                h ^= h >> 16;
                return float(h >> 8) * (1.0 / 16777216.0);
            }

            // Value noise that repeats every 'period' cells on both axes, so it wraps around the column with no seam
            // and its scroll can be wrapped too (no precision loss however long the game runs).
            float MarsPeriodicNoise(float2 p, float2 period, uint seed)
            {
                float2 cell = floor(p);
                float2 f = p - cell;
                float2 u = f * f * (3.0 - 2.0 * f);
                float2 c0 = cell - period * floor(cell / period);
                float2 c1 = c0 + 1.0;
                c1 -= period * step(period, c1);
                float a = MarsCellHash(c0, seed);
                float b = MarsCellHash(float2(c1.x, c0.y), seed);
                float c = MarsCellHash(float2(c0.x, c1.y), seed);
                float d = MarsCellHash(c1, seed);
                return lerp(lerp(a, b, u.x), lerp(c, d, u.x), u.y);
            }

            half4 Frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);

                float2 uv = input.uv;
                float clock = _MarsWind.w;
                float spin = _DevilParams.y;
                uint seed = uint(_DevilParams.w * 65536.0);

                // u scrolls with the spin, v climbs with the updraft. frac() keeps the numbers small: a jump of one
                // whole turn, or of one vertical period, lands on the same noise.
                float around = max(round(_NoiseScale.x), 1.0);
                float up = max(_NoiseScale.y, 0.1);
                float u = uv.x + uv.y * DEVIL_TWIST;
                float2 p1 = float2((u + frac(spin * clock)) * around,
                                   uv.y * up - frac(DEVIL_RISE_PER_SECOND * clock * up / DEVIL_WRAP_UP) * DEVIL_WRAP_UP);
                float2 p2 = float2((u + frac(spin * clock * 1.3)) * around * 2.0,
                                   uv.y * up * 2.0 - frac(DEVIL_RISE_PER_SECOND * 1.5 * clock * up * 2.0 / (DEVIL_WRAP_UP * 2.0)) * (DEVIL_WRAP_UP * 2.0));
                float n = MarsPeriodicNoise(p1, float2(around, DEVIL_WRAP_UP), seed) * 0.65
                        + MarsPeriodicNoise(p2, float2(around * 2.0, DEVIL_WRAP_UP * 2.0), seed + 7u) * 0.35;
                float dust = lerp(0.25, 1.0, smoothstep(0.2, 0.8, n));

                // Soft silhouette: a column seen edge-on is thin dust, seen face-on it is the full depth.
                float3 normalWS = normalize(input.normalWS);
                float3 toEye = SafeNormalize(_WorldSpaceCameraPos.xyz - input.positionWS);
                float facing = pow(abs(dot(normalWS, toEye)), 1.5);

                // Grows out of the ground, thins with height (denser base, as in rover movies) and fades at the top.
                float v = uv.y;
                float vertical = smoothstep(0.0, 0.08, v) * (1.0 - smoothstep(0.6, 1.0, v)) * lerp(1.0, 0.3, v);

                float alpha = input.color.a * dust * facing * vertical;
                UNITY_BRANCH
                if (_SoftFade > 0.0)
                {
                    alpha *= MarsSoftDepthFade(input.screenPosition, input.eyeDepth, _SoftFade);
                }

                float3 color = MixFog(input.color.rgb, MarsFogFactor(input.eyeDepth));
                return half4(color, alpha);
            }
            ENDHLSL
        }
    }
    Fallback Off
}
