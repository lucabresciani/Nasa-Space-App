// Procedural Mars sky for the day/night cycle: butterscotch haze by day, a blue glow around the
// setting sun, the Milky Way at night. Sun position and sky colours come from DayNightCycle as globals,
// so the material itself only holds the look of the sun, the Milky Way and the ice clouds.
//
// The stars are no longer procedural: they are the real catalogue (plus the planets, Phobos and Deimos from their
// ephemerides), drawn as point sprites by MarsNightSky with the Mars Stars shader on top of this sky. The sky keeps
// only the Milky Way's diffuse glow, in the same celestial frame (_MarsCelestial), so the two turn together.
// Shared globals and helpers live in MarsSkyCommon.hlsl, the ice-cloud deck in MarsClouds.hlsl (the star points
// read the same deck, so a star hides behind exactly the cloud drawn here).
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

        [Header(Milky Way)]
        _MilkyWay ("Milky Way Brightness", Range(0, 3)) = 1

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
            // _MarsSunDir, _MarsStars, _MarsCelestial, _MarsDust and the celestial / extinction helpers.
            #include "Assets/Mars/Shaders/MarsSkyCommon.hlsl"
            // _MarsWind, _MarsCloud, CloudOpacity, ValueNoise and MarsCloudCover (the deck, shared with Mars Stars).
            #include "Assets/Mars/Shaders/MarsClouds.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float _SunSize;
                float _SunBrightness;
                float4 _GlowColor;
                float4 _AureoleColor;
                float4 _SunsetColor;
                float _MilkyWay;
                float4 _CloudColor;
                float _CloudScale;
            CBUFFER_END

            // Set by DayNightCycle. Sky colours arrive in gamma space.
            float4 _MarsSkyHorizon;
            float4 _MarsSkyZenith;

            static const float MarsRadiusKm = 3389.5; // mean radius

            // ICRF (J2000 equatorial) -> galactic, the IAU definition as tabulated for Hipparcos (ESA 1997, vol. 1,
            // sec. 1.5.3). Rows: toward the galactic centre (l = 0, b = 0), toward l = 90, and the north galactic pole.
            static const float3x3 GalacticFromIcrf = float3x3(
                -0.0548755604, -0.8734370902, -0.4838350155,
                 0.4941094279, -0.4448296300,  0.7469822445,
                -0.8676661490, -0.1980763734,  0.4559837762);

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

            // The Milky Way's diffuse glow in the direction dirWS, linear, before the night, cloud and extinction
            // factors. An ARTISTIC approximation of its shape, not a photometric map: a thin disk (Gaussian, 1 sigma
            // about 5 degrees of galactic latitude) brightening toward the galactic centre, the bulge in Sagittarius,
            // and the Great Rift, the dust lane that splits it from Cygnus to Sagittarius just north of the plane.
            // Clumps come from value noise on the 3D galactic direction, so there is no seam at l = +-180 degrees.
            float3 MilkyWay(float3 dirWS)
            {
                float3 g = mul(GalacticFromIcrf, MarsWorldToIcrf(dirWS));
                float b = asin(clamp(g.z, -1.0, 1.0)); // galactic latitude, radians
                float l = atan2(g.y, g.x);             // galactic longitude, radians, 0 toward the centre
                float disk = exp(-b * b / (2.0 * 0.09 * 0.09)) * (0.35 + 0.65 * (0.5 + 0.5 * cos(l)));
                float bulge = exp(-l * l / (2.0 * 0.45 * 0.45)) * exp(-b * b / (2.0 * 0.12 * 0.12));
                float lane = (b - 0.03) / 0.035;
                float rift = 1.0 - 0.55 * exp(-lane * lane) * (1.0 - smoothstep(0.2, 1.2, abs(l - 0.44)));
                float n = 0.6 * ValueNoise(g.xy * 7.0 + g.z * 17.0, 5u) + 0.4 * ValueNoise(g.xy * 15.0 - g.z * 31.0, 6u);
                return float3(0.80, 0.84, 0.95) * ((disk + 0.8 * bulge) * rift * lerp(0.55, 1.25, n) * 0.012);
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

                // Water-ice clouds (MarsClouds.hlsl): a flat deck at _MarsCloud.w km, skipped entirely when clear.
                float cloud = 0.0; // opacity of the deck in this direction
                if (_MarsCloud.z > 0.001)
                {
                    float altitude = max(_MarsCloud.w, 1.0);
                    cloud = MarsCloudCover(dir, pixelAngle, _CloudScale);

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

                // The Milky Way at night, behind the clouds and dimmed through the air like the star points
                // (MarsExtinction). The stars themselves are drawn by MarsNightSky after the sky.
                if (_MarsStars > 0.0)
                {
                    color += MilkyWay(dir) * (_MilkyWay * _MarsStars * smoothstep(0.0, 0.25, dir.y) * (1.0 - cloud) * MarsExtinction(dir.y));
                }
                return half4(color, 1.0);
            }
            ENDHLSL
        }
    }
    Fallback Off
}
