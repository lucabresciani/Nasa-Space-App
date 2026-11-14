// Lit, soft dust particles for the weather: wind streaks, dust sheets, sand streamers and dust-devil skirts.
// Lighting comes from MarsDustLighting.hlsl: DayNightCycle's ambient plus the main light scattered forward,
// so the dust glows toward the sun, dims at dusk and never shines at night.
//
// The particle renderer MUST use custom vertex streams Position, Color, UV, Center, in that order. Unity packs them
// as POSITION, COLOR, TEXCOORD0.xy = UV, TEXCOORD0.zw + TEXCOORD1.x = Center (the particle's position).
// MarsWeatherEffectsSetup sets them; check the Renderer module's stream list if particles look wrong.
//
// Near the camera: a particle whose centre is closer than _NearFade.x collapses into a zero-area quad in the vertex
// shader, which produces no fragments at all. An alpha fade would still rasterise the whole quad, so this is what
// keeps a 16 m dust sheet drifting through the eye from costing a full screen of overdraw (or hiding the view).
// Between _NearFade.x and .y the particle fades in, so the collapse itself is never visible.
Shader "NasaSpaceApp/Mars Dust Particle"
{
    Properties
    {
        _BaseMap ("Shape (alpha)", 2D) = "white" {}
        [HDR] _BaseColor ("Tint (linear multiplier; alpha scales opacity)", Color) = (1, 1, 1, 1)
        _NearFade ("Near Fade (x: gone below, y: fully visible from; metres)", Vector) = (0.3, 1, 0, 0)
        _SoftFade ("Soft Depth Fade (metres; 0 = off, for renderers without a depth texture)", Float) = 0.5
        _Phase ("Forward Scattering g (Henyey-Greenstein)", Range(0, 0.9)) = 0.6
    }

    SubShader
    {
        Tags { "Queue" = "Transparent" "RenderType" = "Transparent" "IgnoreProjector" = "True" "PreviewType" = "Plane" "RenderPipeline" = "UniversalPipeline" }

        Pass
        {
            Name "Dust"
            Tags { "LightMode" = "UniversalForward" }
            Blend SrcAlpha OneMinusSrcAlpha
            ZWrite Off
            Cull Off

            HLSLPROGRAM
            #pragma target 3.5
            #pragma vertex Vert
            #pragma fragment Frag

            #include_with_pragmas "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Fog.hlsl"
            #include "MarsDustLighting.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _BaseMap_ST;
                float4 _BaseColor;
                float4 _NearFade;
                float _SoftFade;
                float _Phase;
            CBUFFER_END

            TEXTURE2D(_BaseMap);
            SAMPLER(sampler_BaseMap);

            struct Attributes
            {
                float4 positionOS : POSITION;  // particle vertices arrive in world space (identity object matrix)
                float4 color : COLOR;
                float4 texcoord0 : TEXCOORD0;  // xy: UV, zw: Center.xy
                float texcoord1 : TEXCOORD1;   // x: Center.z
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float2 uv : TEXCOORD0;
                float4 color : TEXCOORD1;          // rgb: lit colour, a: opacity including the near fade
                float4 screenPosition : TEXCOORD2; // for the soft depth fade
                float eyeDepth : TEXCOORD3;        // view depth, for the soft fade and the fog
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings Vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);

                float3 center = float3(input.texcoord0.zw, input.texcoord1);
                float distanceToEye = distance(center, _WorldSpaceCameraPos.xyz);
                if (distanceToEye < _NearFade.x)
                {
                    // All four corners share the centre, so they all land on this same point outside the clip
                    // volume: a degenerate quad with zero fragments.
                    output.positionCS = float4(2.0, 2.0, 2.0, 1.0);
                    return output;
                }

                float3 positionWS = TransformObjectToWorld(input.positionOS.xyz);
                output.positionCS = TransformWorldToHClip(positionWS);
                output.screenPosition = MarsScreenPosition(output.positionCS);
                output.eyeDepth = -TransformWorldToView(positionWS).z;
                output.uv = TRANSFORM_TEX(input.texcoord0.xy, _BaseMap);

                // Lit per vertex: the light barely changes across a particle, and the big sheets are where the
                // overdraw is, so every instruction kept out of the fragment shader counts.
                float nearFade = saturate((distanceToEye - _NearFade.x) / max(_NearFade.y - _NearFade.x, 1e-3));
                float3 light = MarsDustLight(positionWS, _Phase);
                output.color = float4(input.color.rgb * _BaseColor.rgb * light, input.color.a * _BaseColor.a * nearFade);
                return output;
            }

            half4 Frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);

                float4 shape = SAMPLE_TEXTURE2D(_BaseMap, sampler_BaseMap, input.uv);
                float alpha = shape.a * input.color.a;
                UNITY_BRANCH
                if (_SoftFade > 0.0)
                {
                    alpha *= MarsSoftDepthFade(input.screenPosition, input.eyeDepth, _SoftFade);
                }

                float3 color = shape.rgb * input.color.rgb;
                color = MixFog(color, MarsFogFactor(input.eyeDepth));
                return half4(color, alpha);
            }
            ENDHLSL
        }
    }
    Fallback Off
}
