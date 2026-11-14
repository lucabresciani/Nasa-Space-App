// MARTIS title / pause screen: the planet.
//
// An analytically ray-cast sphere drawn on a SQUARE UnityEngine.UI.RawImage (ScreenSpaceOverlay canvas). There is
// no mesh and no camera: every fragment of the quad computes where an orthographic ray hits a unit sphere, looks the
// surface up in two equirectangular maps and lights it with one directional sun. Outside the disc it draws a thin
// atmospheric halo with straight alpha.
//
// Spaces and conventions (the same ones Tools/title/preview_planet.py implements offline):
//   quad uv      (0,0) bottom-left, (1,1) top-right; the disc is centred, its diameter is _DiscFraction of the quad
//   view space   +x right, +y up, +z toward the viewer
//   planet space +Y north pole; longitude lon = atan2(n.x, n.z) (east positive toward +X); latitude lat = asin(n.y)
//   maps         u = lon / (2 pi) + 0.5, v = lat / pi + 0.5: 0 E in the centre column, north at the top
//   _RotX/Y/Z    rows of the view -> planet rotation (nP = R * nV)
//   _NormalTex   plain RGB in a LINEAR texture (not a Unity "Normal map" import): R east, G north, B up
//
// Colour: Unity runs in LINEAR colour space. _MainTex is an sRGB texture (sampled linear), _AtmoColor is a Color
// (converted by Unity), all math is linear, the output is linear. No _Time: the menu runs at timeScale 0 and the
// C# side animates the rotation rows itself.
//
// Structure follows Unity's built-in UI/Default (stencil block, GUI ZTest, vertex colour) so that masks and
// CanvasGroup fades behave; RectMask2D clipping is deliberately not implemented (no keywords in this shader).
Shader "Martis/TitlePlanet"
{
    Properties
    {
        _MainTex ("Colour (equirect, sRGB)", 2D) = "white" {}
        [NoScaleOffset] _NormalTex ("Normal (equirect, plain RGB, linear)", 2D) = "bump" {}

        _RotX ("View to Planet Rotation, Row X", Vector) = (1, 0, 0, 0)
        _RotY ("View to Planet Rotation, Row Y", Vector) = (0, 1, 0, 0)
        _RotZ ("View to Planet Rotation, Row Z", Vector) = (0, 0, 1, 0)
        _SunDir ("Sun Direction (view space)", Vector) = (0.45, 0.38, 0.81, 0)

        _DiscFraction ("Disc Diameter / Quad Size", Float) = 0.8
        _Exposure ("Exposure", Float) = 1.25
        _NormalStrength ("Normal Strength", Float) = 1.0
        _Night ("Night Side Level", Float) = 0.012

        _AtmoColor ("Atmosphere Colour", Color) = (0.93, 0.60, 0.38, 1)
        _AtmoStrength ("Limb Haze Strength", Float) = 0.55
        _HaloStrength ("Halo Strength", Float) = 0.45
        _HaloWidth ("Halo Width (disc radii)", Float) = 0.045

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
            sampler2D _NormalTex;
            float4 _RotX;
            float4 _RotY;
            float4 _RotZ;
            float4 _SunDir;
            float _DiscFraction;
            float _Exposure;
            float _NormalStrength;
            float _Night;
            float4 _AtmoColor;
            float _AtmoStrength;
            float _HaloStrength;
            float _HaloWidth;
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

            float4 frag(v2f i) : SV_Target
            {
                const float INV_TWO_PI = 0.15915494309189535;
                const float INV_PI = 0.3183098861837907;

                // ---- Ray / sphere (orthographic): p is in disc radii, r = 1 is the limb.
                float disc = max(_DiscFraction, 1e-3);
                float2 p = (i.texcoord * 2.0 - 1.0) / disc;
                float r = length(p);
                float z = sqrt(saturate(1.0 - r * r));
                float3 nV = float3(p.x, p.y, z); // outward normal in view space; a unit vector only for r <= 1

                float sunLen = max(length(_SunDir.xyz), 1e-5);
                float3 sV = _SunDir.xyz / sunLen;

                float3 nP = float3(dot(_RotX.xyz, nV), dot(_RotY.xyz, nV), dot(_RotZ.xyz, nV));
                float3 sP = float3(dot(_RotX.xyz, sV), dot(_RotY.xyz, sV), dot(_RotZ.xyz, sV));

                // ---- Equirectangular lookup.
                float clRaw = length(nP.xz);
                float lon = (clRaw > 1e-6) ? atan2(nP.x, nP.z) : 0.0;
                float lat = asin(clamp(nP.y, -1.0, 1.0)); // the clamp only matters outside the disc (no NaN there)
                float uA = lon * INV_TWO_PI;              // -0.5 .. 0.5, discontinuous at lon = +-180 (the map's edge)
                float uB = frac(uA);                      //  0 .. 1,     discontinuous at lon = 0     (the map's centre)
                float v = lat * INV_PI + 0.5;

                // uA and uB differ by a constant away from their own seams, so their screen derivatives agree there;
                // taking them from whichever is smoother in this pixel quad removes the one-pixel mip seam that the
                // atan2 wrap would otherwise draw down the far meridian.
                float fwA = fwidth(uA);
                float fwB = fwidth(uB);
                float2 duA = float2(ddx(uA), ddy(uA));
                float2 duB = float2(ddx(uB), ddy(uB));
                float useB = (fwB < fwA) ? 1.0 : 0.0;
                float2 du = lerp(duA, duB, useB);
                float2 dv = float2(ddx(v), ddy(v));

                float2 uvMap = float2(uA + 0.5, v);
                float2 gradX = float2(du.x, dv.x);
                float2 gradY = float2(du.y, dv.y);

                float3 albedo = tex2Dgrad(_MainTex, uvMap, gradX, gradY).rgb;
                float3 t = tex2Dgrad(_NormalTex, uvMap, gradX, gradY).xyz * 2.0 - 1.0;
                t.xy *= _NormalStrength;

                // ---- Tangent frame in planet space (east = d n / d lon, north = d n / d lat, both unit).
                float cl = max(1e-4, clRaw);
                float3 east = float3(nP.z, 0.0, -nP.x) / cl;
                float3 north = float3(-nP.y * nP.x / cl, cl, -nP.y * nP.z / cl);
                float3 nBraw = east * t.x + north * t.y + nP * t.z;
                // Fallback to the geometric normal if the map decodes to ~zero (e.g. a mid-grey placeholder), so the
                // planet is never left unlit by a missing or mis-imported normal texture.
                float nBlen2 = dot(nBraw, nBraw);
                float3 nB = (nBlen2 > 1e-6) ? nBraw * rsqrt(nBlen2) : nP;

                // ---- Lighting.
                float ndl0 = dot(nP, sP); // geometric
                float ndl = dot(nB, sP);  // bumped
                float terminator = smoothstep(-0.10, 0.22, ndl0);
                float diffuse = saturate(ndl) * terminator;
                float3 surface = albedo * (_Night + _Exposure * diffuse);

                // Limb haze inside the disc.
                float k = 1.0 - z;
                float rim = k * k * k;
                float atmoLit = smoothstep(-0.25, 0.55, ndl0);
                surface += _AtmoColor.rgb * _AtmoStrength * rim * atmoLit;

                // ---- Halo outside the disc.
                float d = max(0.0, r - 1.0);
                float limbLit = smoothstep(-0.2, 0.7, dot(p / max(r, 1e-4), sV.xy));
                float haloA = saturate(exp(-d / max(_HaloWidth, 1e-5)) * _HaloStrength * limbLit);
                // Window: the exponential never reaches zero, and in linear blending even a 0.2 % tail is a few
                // sRGB steps over a near-black backdrop. Force it to exactly zero at the quad edge
                // (r = 1 / _DiscFraction) so the quad's outline can never show, whatever width the C# side sets.
                float dMax = max(1e-4, 1.0 / disc - 1.0);
                haloA *= 1.0 - smoothstep(0.6, 1.0, d / dMax);
                float3 haloColour = _AtmoColor.rgb;

                // ---- Anti-aliased limb. Same as smoothstep(1 + aa/2, 1 - aa/2, r), written with ascending edges.
                float aa = max(fwidth(r), 1e-5);
                float inside = 1.0 - smoothstep(1.0 - aa * 0.5, 1.0 + aa * 0.5, r);

                float3 rgb = lerp(haloColour, surface, inside);
                float a = lerp(haloA, 1.0, inside);

                return float4(rgb * i.color.rgb, a * i.color.a);
            }
            ENDCG
        }
    }
}
