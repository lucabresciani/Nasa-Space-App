// Constellation stick figures for the night-sky overlay (MarsNightSky, key K): a MeshTopology.Lines mesh whose
// vertices are ICRF unit directions of the stars the figures join, put on the far plane like the stars themselves.
// A straight segment between two directions at infinity is the great-circle arc between them under the
// perspective projection, so the lines meet the star points exactly and stay straight on screen.
//
// An overlay, like a planetarium's: deliberately NOT dimmed by clouds, dust or daylight. MarsNightSky fades it in
// and out through _Opacity; it only fades at the horizon, where the terrain takes over anyway.
Shader "NasaSpaceApp/Mars Constellation Lines"
{
    Properties
    {
        _Color ("Line Colour (alpha: opacity)", Color) = (0.42, 0.58, 0.95, 0.55)
        _Opacity ("Opacity (faded by MarsNightSky)", Range(0, 1)) = 1
    }

    SubShader
    {
        Tags { "Queue" = "Transparent-460" "RenderType" = "Transparent" "IgnoreProjector" = "True" "RenderPipeline" = "UniversalPipeline" }

        Pass
        {
            Name "Lines"
            Blend SrcAlpha One
            ZWrite Off
            ZTest LEqual
            Cull Off

            HLSLPROGRAM
            #pragma vertex Vert
            #pragma fragment Frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Assets/Mars/Shaders/MarsSkyCommon.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float4 _Color;
                float _Opacity;
            CBUFFER_END

            struct Attributes
            {
                float3 positionOS : POSITION; // ICRF unit direction
                float4 color : COLOR;         // per-vertex rgba (white from MarsNightSky; the material sets the colour)
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float4 color : TEXCOORD0; // linear rgb, alpha
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings Vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);

                float3 dirWS = normalize(MarsIcrfToWorld(input.positionOS));
                output.positionCS = MarsSkyClip(dirWS);
                // Fades out just across the horizon line, so a figure that sets does not end in a hard cut.
                float alpha = _Color.a * _Opacity * input.color.a * smoothstep(-0.02, 0.06, dirWS.y);
                output.color = float4(_Color.rgb * input.color.rgb, alpha);
                return output;
            }

            float4 Frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);
                return input.color;
            }
            ENDHLSL
        }
    }
    Fallback Off
}
