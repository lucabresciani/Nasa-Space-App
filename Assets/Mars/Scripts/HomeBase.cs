using UnityEngine;

namespace NasaSpaceApp
{
    /// <summary>
    /// Where HOME is: the point the suit navigates back to (HOME distance/bearing, HOME marker on the dial and the map,
    /// the radio link's base antenna). Default = the world origin (the scene spawn). A loaded web mission moves it to the
    /// mission pad (<see cref="NasaSpaceApp.Mission.MissionLink"/>). Readers compare <see cref="Version"/> to notice a move.
    /// </summary>
    public static class HomeBase
    {
        /// <summary>HOME in world space (y = ground height, or 0 when it was never measured).</summary>
        public static Vector3 Position { get; private set; }

        /// <summary>True when <see cref="Position"/> is a mission pad rather than the scene spawn.</summary>
        public static bool IsMissionPad { get; private set; }

        /// <summary>Incremented on every <see cref="Set"/> / <see cref="Reset"/>.</summary>
        public static int Version { get; private set; }

        // Domain reload is off: back to the spawn each play session.
        [RuntimeInitializeOnLoadMethod(RuntimeInitializeLoadType.SubsystemRegistration)]
        private static void ResetStatics()
        {
            Position = Vector3.zero;
            IsMissionPad = false;
            Version = 0;
        }

        /// <summary>Moves HOME to a mission pad.</summary>
        public static void Set(Vector3 world)
        {
            Position = world;
            IsMissionPad = true;
            Version++;
        }

        /// <summary>HOME back to the scene spawn (world origin).</summary>
        public static void Reset()
        {
            Position = Vector3.zero;
            IsMissionPad = false;
            Version++;
        }

        /// <summary>Horizontal offset from <paramref name="from"/> to HOME: x = east, y = north (m).</summary>
        public static Vector2 OffsetFrom(Vector3 from) => new Vector2(Position.x - from.x, Position.z - from.z);
    }
}
