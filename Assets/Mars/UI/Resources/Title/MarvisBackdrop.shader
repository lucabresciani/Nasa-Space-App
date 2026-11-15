// MARVIS title / pause screen: the star backdrop.
//
// A slowly scrolling window into a star strip, drawn on a full-screen UnityEngine.UI.RawImage (ScreenSpaceOverlay
// canvas). The strip is 8192 x 2048: 360 deg of galactic longitude along U (repeats) by +-45 deg of latitude along V
// (clamps; this shader fades it to black before the edge, so a tilted window never shows a hard border).
//
//   _Zoom     fraction of the strip HEIGHT that the quad height covers
//   _Tilt     rotation of the window, radians
//   _Scroll   u at the quad centre (the C# side may wrap it into 0..1; the sampler repeats)
//   _VCenter  strip v at the quad centre
//
// The texture's U wrap mode must be Repeat: u is deliberately NOT wrapped with frac() here, because that would put
// a mip seam (a one-pixel vertical line) where it jumps.
//
// Colour: LINEAR colour space; the strip is sampled linear, _Tint is a Color (converted by Unity), output is linear.
// No _Time: the menu runs at timeScale 0, so animated time arrives as _UnscaledTime (seconds).
//
// Structure follows Unity's built-in UI/Default (stencil block, GUI ZTest, vertex colour) so that CanvasGroup fades
// behave; RectMask2D clipping is deliberately not implemented (no keywords in this shader).
Shader "Marvis/TitleBackdrop"
{
    Properties
    {
        _MainTex ("Star Strip (360 x 90 deg, U repeat)", 2D) = "black" {}

        _Aspect ("Quad Width / Height", Float) = 1.7778
        _Zoom ("Zoom (strip height fraction)", Float) = 0.62
        _Tilt ("Tilt (radians)", Float) = -0.14
        _Scroll ("Scroll (u offset)", Float) = 0
        _VCenter ("Strip V at Quad Centre", Float) = 0.5

        _Exposure ("Exposure", Float) = 1.0
        _Tint ("Tint", Color) = (1, 1, 1, 1)
        _Twinkle ("Twinkle", Range(0, 1)) = 0.3
        _Vignette ("Vignette", Float) = 0.35
        _UnscaledTime ("Unscaled Time (seconds)", Float) = 0

        _StencilComp ("Stencil Comparison", Float) = 8
        _Stencil ("Stencil ID", Float) = 0
        _StencilOp ("Stencil Operation", Float) = 0
        _StencilWriteMask ("Stencil Write Mask", Float) = 255
        _StencilReadMask ("Stencil Read Mask", Float) = 255

        _ColorMask ("Color Mask", Float) = 15
    }

    SubShader
    {
        Tags
        {
            "Queue" = "Transparent"
            "IgnoreProjector" = "True"
            "RenderType" = "Transparent"
            "PreviewType" = "Plane"
            "CanUseSpriteAtlas" = "True"
        }

        Stencil
        {
            Ref [_Stencil]
            Comp [_StencilComp]
            Pass [_StencilOp]
            ReadMask [_StencilReadMask]
            WriteMask [_StencilWriteMask]
        }

        Cull Off
        Lighting Off
        ZWrite Off
        ZTest [unity_GUIZTestMode]
        Blend SrcAlpha OneMinusSrcAlpha
        ColorMask [_ColorMask]

        Pass
        {
            Name "Default"

            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0

            #include "UnityCG.cginc"
            #include "UnityUI.cginc"

            struct appdata_t
            {
                float4 vertex : POSITION;
                float4 color : COLOR;
                float2 texcoord : TEXCOORD0;
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct v2f
            {
                float4 vertex : SV_POSITION;
                float4 color : COLOR;
                float2 texcoord : TEXCOORD0;
                UNITY_VERTEX_OUTPUT_STEREO
            };

            sampler2D _MainTex;
            float _Aspect;
            float _Zoom;
            float _Tilt;
            float _Scroll;
            float _VCenter;
            float _Exposure;
            float4 _Tint;
            float _Twinkle;
            float _Vignette;
            float _UnscaledTime;
            int _UIVertexColorAlwaysGammaSpace;

            v2f vert(appdata_t v)
            {
                v2f o;
                UNITY_SETUP_INSTANCE_ID(v);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(o);
                o.vertex = UnityObjectToClipPos(v.vertex);
                o.texcoord = v.texcoord;

                // Same handling as UI/Default: the canvas may hand over gamma-space vertex colours.
                if (_UIVertexColorAlwaysGammaSpace)
                {
                    if (!IsGammaSpace())
                    {
                        v.color.rgb = UIGammaToLinear(v.color.rgb);
                    }
                }
                o.color = v.color;
                return o;
            }

            // Two independent values in 0..1 from an integer cell id (no sin: stable across GPUs).
            float2 hash22(float2 c)
            {
                float3 p3 = frac(float3(c.x, c.y, c.x) * float3(0.1031, 0.1030, 0.0973));
                p3 += dot(p3, p3.yzx + 33.33);
                return frac((p3.xx + p3.yz) * p3.zy);
            }

            float4 frag(v2f i) : SV_Target
            {
                // ---- Window into the strip.
                float2 q = (i.texcoord - 0.5) * float2(_Aspect, 1.0);
                float sn = sin(_Tilt);
                float cs = cos(_Tilt);
                q = float2(q.x * cs - q.y * sn, q.x * sn + q.y * cs);

                float v = _VCenter + q.y * _Zoom;
                float u = _Scroll + q.x * _Zoom * 0.25; // the strip is 4x wider than tall: 0.25 keeps stars round

                float3 col = tex2D(_MainTex, float2(u, v)).rgb * _Exposure * _Tint.rgb;

                // Feather the strip's top and bottom edges to black (also covers v outside 0..1).
                // Same as smoothstep(0, 0.04, v) * smoothstep(1, 0.96, v), written with ascending edges.
                col *= smoothstep(0.0, 0.04, v) * (1.0 - smoothstep(0.96, 1.0, v));

                // ---- Twinkle: only bright pixels scintillate, each 6-texel cell with its own phase and rate.
                // The cell column is taken from frac(u) so that the pattern does not jump when the C# side wraps
                // _Scroll (8192 / 6 is not an integer). frac() here feeds the hash only, never the texture lookup.
                float2 cell = floor(float2(frac(u) * 8192.0, v * 2048.0) / 6.0);
                float2 h = hash22(cell);
                float phase = h.x * 6.283185307179586;
                float rate = lerp(2.0, 5.0, h.y); // rad/s
                float lum = dot(col, float3(0.2126, 0.7152, 0.0722));
                float tw = 1.0 + _Twinkle * sin(_UnscaledTime * rate + phase) * smoothstep(0.06, 0.45, lum);
                col *= tw;

                // ---- Vignette.
                float2 c = i.texcoord - 0.5;
                col *= 1.0 - _Vignette * saturate(dot(c, c) * 2.2);

                return float4(col * i.color.rgb, i.color.a);
            }
            ENDCG
        }
    }
}
