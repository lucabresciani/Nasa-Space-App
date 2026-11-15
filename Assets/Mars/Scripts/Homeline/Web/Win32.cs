#if UNITY_STANDALONE_WIN || UNITY_EDITOR_WIN
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace NasaSpaceApp.Homeline.Web
{
    /// <summary>
    /// The few Win32 calls the web planner needs: finding the game window, letting the viewer take the foreground,
    /// and copying desktop pixels for the hand-off test's screenshot.
    /// </summary>
    internal static class Win32
    {
        public const uint SrcCopy = 0x00CC0020;

        [StructLayout(LayoutKind.Sequential)]
        public struct Rect
        {
            public int Left, Top, Right, Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct Point
        {
            public int X, Y;
        }

        /// <summary>BITMAPINFOHEADER (40 bytes); enough as a BITMAPINFO for 32-bit uncompressed pixels.</summary>
        [StructLayout(LayoutKind.Sequential)]
        public struct BitmapInfoHeader
        {
            public uint Size;
            public int Width, Height;
            public ushort Planes, BitCount;
            public uint Compression, SizeImage;
            public int XPelsPerMeter, YPelsPerMeter;
            public uint ClrUsed, ClrImportant;
        }

        public delegate bool EnumWindowsProc(IntPtr window, IntPtr lParam);

        [DllImport("kernel32.dll")]
        public static extern uint GetCurrentThreadId();

        [DllImport("user32.dll")]
        public static extern bool AllowSetForegroundWindow(int processId);

        [DllImport("user32.dll")]
        public static extern bool EnumThreadWindows(uint threadId, EnumWindowsProc callback, IntPtr lParam);

        [DllImport("user32.dll")]
        public static extern bool IsWindowVisible(IntPtr window);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        public static extern int GetClassName(IntPtr window, StringBuilder name, int capacity);

        [DllImport("user32.dll")]
        public static extern IntPtr GetActiveWindow();

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);

        [DllImport("user32.dll")]
        public static extern bool GetWindowRect(IntPtr window, out Rect rect);

        [DllImport("user32.dll")]
        public static extern bool GetClientRect(IntPtr window, out Rect rect);

        [DllImport("user32.dll")]
        public static extern bool ClientToScreen(IntPtr window, ref Point point);

        [DllImport("user32.dll")]
        public static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll")]
        public static extern int ReleaseDC(IntPtr window, IntPtr dc);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleDC(IntPtr dc);

        [DllImport("gdi32.dll")]
        public static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int width, int height);

        [DllImport("gdi32.dll")]
        public static extern IntPtr SelectObject(IntPtr dc, IntPtr obj);

        [DllImport("gdi32.dll")]
        public static extern bool BitBlt(IntPtr target, int x, int y, int width, int height, IntPtr source, int sourceX, int sourceY, uint rop);

        [DllImport("gdi32.dll")]
        public static extern int GetDIBits(IntPtr dc, IntPtr bitmap, uint firstLine, uint lines, [Out] byte[] bits,
                                           ref BitmapInfoHeader info, uint usage);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteObject(IntPtr obj);

        [DllImport("gdi32.dll")]
        public static extern bool DeleteDC(IntPtr dc);

        /// <summary>The client area of a window in screen pixels; false when the window is gone or has no area.</summary>
        public static bool ClientRectOnScreen(IntPtr window, out int x, out int y, out int width, out int height)
        {
            x = y = width = height = 0;
            var origin = new Point();
            if (window == IntPtr.Zero || !GetClientRect(window, out Rect r) || !ClientToScreen(window, ref origin))
            {
                return false;
            }
            x = origin.X;
            y = origin.Y;
            width = r.Right - r.Left;
            height = r.Bottom - r.Top;
            return width > 0 && height > 0;
        }
    }
}
#endif
