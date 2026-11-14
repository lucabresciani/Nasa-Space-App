// The night sky's points: the catalogue's stars, the planets, the Moon, Phobos and Deimos, drawn by MarsNightSky as
// screen-space sprites on top of the sky (after it, additively, at the far plane: terrain hides them).
//
// Each object is one quad of four vertices that all carry the same ICRF direction; the vertex shader puts them on
// the far plane and opens the quad in PIXELS around that point. Sizes are in pixels, not degrees, on purpose: at a
// modest resolution a real star (far below a pixel) would otherwise vanish or shimmer, so every star gets at least
// a ~1.4 px Gaussian and brightness is shown by both size and intensity (artistic, like a planetarium projector).
// Positions are the real ones: the C# side builds the mesh from the catalogue and the ephemerides.
//
// Vertex layout (MarsNightSky builds the mesh to match, SPEC 5.4):
//   POSITION  float3  ICRF (J2000 equator) unit direction of the object
//   COLOR     float4  linear rgb tint (a unused)
//   TEXCOORD0 float4  x, y: quad corner in {-1, 1}; z: apparent visual magnitude; w: kind
//   TEXCOORD1 float4  kind 2 only: xyz unit direction from Mars to the Sun (ICRF), w: angular radius (radians)
//   kind: 0 star, 1 point body (a planet or moon too small for a disk), 2 disk body (Phobos: resolved, with phase)
//
// Visibility follows the night (_MarsSkyDark: brighter limit while the sky is light), the air (MarsExtinction,
// toward the horizon and through dust) and the ice-cloud deck the sky draws (MarsCloudCover, the same noise).
// A point that ends up invisible collapses to a zero-area quad, which costs no fragments.
Shader "NasaSpaceApp/Mars Stars"
{
    Properties
    {
        _MinSizePx ("Faintest Radius (pixels)", Range(0.5, 4)) = 1.4
        _MaxSizePx ("Brightest Radius (pixels)", Range(1, 12)) = 4.5
        _Brightness ("Brightness (HDR)", Range(0, 8)) = 1.6
        _LimitMag ("Limiting Magnitude at Full Night", Range(0, 8)) = 6
        _CloudScale ("Cloud Noise Cells per km (copied from the sky material)", Range(0.01, 0.3)) = 0.06
    }

    SubShader
    {
        Tags { "Queue" = "Transparent-450" "RenderType" = "Transparent" "IgnoreProjector" = "True" "RenderPipeline" = "UniversalPipeline" }

        Pass
        {
            Name "Stars"
            Blend One One
            ZWrite Off
            ZTest LEqual
            Cull Off

            HLSLPROGRAM
            #pragma target 3.5
            #pragma vertex Vert
            #pragma fragment Frag

            #include "Packages/com.unity.render-pipelines.universal/ShaderLibrary/Core.hlsl"
            #include "Assets/Mars/Shaders/MarsSkyCommon.hlsl"
            #include "Assets/Mars/Shaders/MarsClouds.hlsl"

            CBUFFER_START(UnityPerMaterial)
                float _MinSizePx;
                float _MaxSizePx;
                float _Brightness;
                float _LimitMag;
                float _CloudScale;
            CBUFFER_END

            struct Attributes
            {
                float3 positionOS : POSITION;  // ICRF unit direction
                float4 color : COLOR;          // linear rgb tint
                float4 texcoord0 : TEXCOORD0;  // corner xy, magnitude, kind
                float4 texcoord1 : TEXCOORD1;  // kind 2: Sun direction (ICRF), angular radius (rad)
                UNITY_VERTEX_INPUT_INSTANCE_ID
            };

            struct Varyings
            {
                float4 positionCS : SV_POSITION;
                float3 color : TEXCOORD0;    // tint x peak brightness, linear HDR
                float2 cornerPx : TEXCOORD1; // this point's offset from the object's centre, pixels (x right, y up on screen)
                float3 shape : TEXCOORD2;    // x: Gaussian sigma (px), y: 1 for a resolved disk, z: disk radius (px)
                float3 sunView : TEXCOORD3;  // disk only: unit Sun direction in the disk's frame (x right, y up, +z to the eye)
                UNITY_VERTEX_OUTPUT_STEREO
            };

            Varyings Vert(Attributes input)
            {
                Varyings output = (Varyings)0;
                UNITY_SETUP_INSTANCE_ID(input);
                UNITY_INITIALIZE_VERTEX_OUTPUT_STEREO(output);

                float3 dirWS = normalize(MarsIcrfToWorld(input.positionOS));
                float4 clip = MarsSkyClip(dirWS);

                // Pixels per radian at the centre of the view, in render-target pixels (URP's render scale and dynamic
                // resolution included), so the minimum sizes below really cover that many sampled pixels.
                // |P[1][1]|, read as the length of (P[1][0], P[1][1]): rendering into a texture flips its sign on
                // D3D-like APIs, and a 90-degree Vulkan display pre-rotation moves the target's y scale to P[1][0]
                // (URP's OptimizeProjectionMatrix clears P[1][0] otherwise, so on PC this is just |P[1][1]|).
                float4 screen = GetScaledScreenParams();
                float4x4 projection = UNITY_MATRIX_P;
                float ppr = 0.5 * screen.y * length(projection[1].xy);

                float2 corner = input.texcoord0.xy;
                float magnitude = input.texcoord0.z;
                float kind = input.texcoord0.w;

                // Size from the magnitude: the faintest catalogue stars get _MinSizePx, magnitude -1.5 (Sirius) and
                // brighter _MaxSizePx, quadratic in between so only the few bright ones look big. Artistic.
                float w = saturate((_LimitMag + 0.5 - magnitude) / (_LimitMag + 2.0));
                float radiusPx = lerp(_MinSizePx, _MaxSizePx, w * w);
                float sigma = max(0.5 * radiusPx, 0.7);

                // Phobos (about 0.15-0.2 degrees across from Gale, horizon to zenith) is a disk only when it covers
                // enough pixels to show a phase; otherwise it is drawn as a point like the others.
                float diskPx = input.texcoord1.w * ppr;
                bool isDisk = kind > 1.5 && diskPx >= 1.5;

                // Limiting magnitude: -3.5 in daylight (only Phobos and Deimos, about -9 and -5.5 when full, stay up;
                // artistic) down to _LimitMag at full night. Each object fades in over the half magnitude above it.
                float limit = lerp(-3.5, _LimitMag, smoothstep(0.0, 1.0, _MarsSkyDark));
                float visible = saturate(limit - magnitude + 0.5);
                float transmission = MarsExtinction(dirWS.y);
                // The sky's ice-cloud opacity in this direction (as MarsSky computes it, without the noon thinning,
                // since the points only show at night). The sky's pixel angle is length(fwidth(dir)), |ddx| + |ddy|
                // per component: about sqrt(2) / ppr, so the deck's far octaves fade out where the sky's do.
                float cover = MarsCloudCover(dirWS, 1.41421356 / ppr, _CloudScale);
                float opacity = cover * CloudOpacity * exp(-max(_MarsDust.x, 0.0) / max(dirWS.y, 0.05));
                // A little HDR boost above magnitude -1.5, so the brightest planets catch the bloom. Artistic.
                float peak = lerp(0.22, 1.0, sqrt(w)) * _Brightness * visible * transmission * (1.0 - opacity)
                           * (1.0 + 0.35 * saturate((-1.5 - magnitude) / 3.0));

                // Quad half-size: 3.2 sigma + 1 px cuts the Gaussian off at about 0.5% with the default sizes; a disk
                // adds 1.5 px for its anti-aliased limb. Invisible or below the horizon: zero area, no fragments.
                float halfPx = isDisk ? diskPx + 1.5 : 1.6 * radiusPx + 1.0;
                halfPx = (peak <= 1e-4 || dirWS.y < -0.02) ? 0.0 : halfPx;
                float2 offsetPx = corner * halfPx;
                // Pixels -> clip space at this depth. A flipped projection (_ProjectionParams.x = -1) turns clip y
                // upside down, so the quad's +y corner still lands at the top of the displayed image, where the
                // fragment's cornerPx and the disk's lighting expect it.
                clip.xy += float2(offsetPx.x, offsetPx.y * _ProjectionParams.x) * (2.0 / screen.xy) * clip.w;

                // The Sun as seen from the disk, in the disk's own frame: z along the line of sight toward the eye,
                // x as close to the screen's right as possible. Using the camera axes instead would change the phase
                // as the camera pans. Zero (unused) for stars and points, whose TEXCOORD1 is empty.
                float3 toBody = mul((float3x3)UNITY_MATRIX_V, dirWS);
                float3 sunV = mul((float3x3)UNITY_MATRIX_V, MarsIcrfToWorld(input.texcoord1.xyz));
                float3 axisZ = -toBody;
                float3 axisX = SafeNormalize(float3(1.0, 0.0, 0.0) - axisZ * axisZ.x);
                float3 axisY = cross(axisZ, axisX);
                output.sunView = SafeNormalize(float3(dot(sunV, axisX), dot(sunV, axisY), dot(sunV, axisZ)));

                output.positionCS = clip;
                output.color = input.color.rgb * peak;
                output.cornerPx = offsetPx;
                output.shape = float3(sigma, isDisk ? 1.0 : 0.0, diskPx);
                return output;
            }

            float4 Frag(Varyings input) : SV_Target
            {
                UNITY_SETUP_STEREO_EYE_INDEX_POST_VERTEX(input);

                // Stars and point bodies: a Gaussian spot, exact at any sub-pixel position since cornerPx is
                // interpolated across a screen-aligned quad.
                float r2 = dot(input.cornerPx, input.cornerPx);
                float sigma = input.shape.x;
                float spot = exp(-r2 / (2.0 * sigma * sigma));

                // Resolved disk: a Lambert sphere lit from sunView, with a one-pixel anti-aliased limb.
                float diskPx = max(input.shape.z, 1e-3);
                float rho = sqrt(r2) / diskPx;
                float3 normal = float3(input.cornerPx / diskPx, sqrt(saturate(1.0 - rho * rho)));
                float lit = saturate(dot(normal, input.sunView));
                float edge = saturate((1.0 - rho) * diskPx + 0.5);

                float shade = input.shape.y > 0.5 ? lit * edge : spot;
                return float4(input.color * shade, 1.0);
            }
            ENDHLSL
        }
    }
    Fallback Off
}
