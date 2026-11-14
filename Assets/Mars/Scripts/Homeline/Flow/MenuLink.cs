using System;
using System.Reflection;
using UnityEngine;

namespace NasaSpaceApp.Homeline.Flow
{
    /// <summary>
    /// Link to the MARTIS title/pause screen (NasaSpaceApp.Menu.MartisMenu, built by another workstream).
    /// Bound by reflection so this code compiles and runs whether or not the menu is in the project: without it,
    /// <see cref="Available"/> is false and the flow falls back to its own start key.
    ///
    /// Contract of the menu (agreed 2026-11-14):
    ///   static bool IsOpen                      true while the title or pause screen is up (Time.timeScale is 0)
    ///   static event Action Opened / Closed     the simulation was suspended / actually resumed
    ///   static Func&lt;bool&gt; StartInterceptor      START SIMULATION pressed; true = "handled, I will call StartNow() later"
    ///   static void StartNow()                  main thread; starts or resumes if the menu is open, no-op otherwise
    ///   static Action PlanRequested             when set, the menu shows a MISSION PLAN entry that invokes it
    /// The menu clears the hooks at SubsystemRegistration, so <see cref="Bind"/> must run on every play session.
    /// </summary>
    public sealed class MenuLink
    {
        const string MenuTypeName = "NasaSpaceApp.Menu.MartisMenu";

        readonly Type menu;
        readonly MethodInfo startNow;
        Action opened, closed;

        public bool Available { get { return menu != null; } }

        public MenuLink()
        {
            foreach (Assembly a in AppDomain.CurrentDomain.GetAssemblies())
            {
                menu = a.GetType(MenuTypeName, false);
                if (menu != null) break;
            }
            if (menu != null) startNow = menu.GetMethod("StartNow", BindingFlags.Public | BindingFlags.Static, null, Type.EmptyTypes, null);
        }

        /// <summary>True while the title or pause screen is up. False when there is no menu.</summary>
        public bool IsOpen
        {
            get
            {
                object v = GetStatic("IsOpen");
                return v is bool && (bool)v;
            }
        }

        /// <summary>
        /// Registers the hooks. <paramref name="startInterceptor"/> returns true when it takes over the start
        /// (it must call <see cref="StartNow"/> later).
        /// </summary>
        public void Bind(Func<bool> startInterceptor, Action planRequested, Action onOpened, Action onClosed)
        {
            if (menu == null) return;
            SetStatic("StartInterceptor", startInterceptor);
            SetStatic("PlanRequested", planRequested);
            Unbind();
            opened = onOpened;
            closed = onClosed;
            AddHandler("Opened", opened);
            AddHandler("Closed", closed);
        }

        /// <summary>Removes the event handlers and clears the hooks this link set.</summary>
        public void Unbind()
        {
            if (menu == null) return;
            RemoveHandler("Opened", opened);
            RemoveHandler("Closed", closed);
            opened = null;
            closed = null;
        }

        public void ClearHooks()
        {
            if (menu == null) return;
            Unbind();
            SetStatic("StartInterceptor", null);
            SetStatic("PlanRequested", null);
        }

        /// <summary>Starts or resumes the simulation if the menu is open. Main thread only.</summary>
        public void StartNow()
        {
            if (startNow == null) return;
            try
            {
                startNow.Invoke(null, null);
            }
            catch (Exception e)
            {
                Debug.LogWarning("[HOMELINE] MartisMenu.StartNow failed: " + (e.InnerException ?? e).Message);
            }
        }

        object GetStatic(string name)
        {
            if (menu == null) return null;
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Static;
            PropertyInfo p = menu.GetProperty(name, flags);
            if (p != null && p.CanRead) return p.GetValue(null, null);
            FieldInfo f = menu.GetField(name, flags);
            return f != null ? f.GetValue(null) : null;
        }

        void SetStatic(string name, object value)
        {
            const BindingFlags flags = BindingFlags.Public | BindingFlags.Static;
            try
            {
                FieldInfo f = menu.GetField(name, flags);
                if (f != null)
                {
                    f.SetValue(null, value);
                    return;
                }
                PropertyInfo p = menu.GetProperty(name, flags);
                if (p != null && p.CanWrite)
                {
                    p.SetValue(null, value, null);
                    return;
                }
                Debug.LogWarning("[HOMELINE] MartisMenu has no settable member '" + name + "'");
            }
            catch (Exception e)
            {
                Debug.LogWarning("[HOMELINE] MartisMenu." + name + " could not be set: " + e.Message);
            }
        }

        void AddHandler(string eventName, Action handler)
        {
            if (handler == null) return;
            EventInfo e = menu.GetEvent(eventName, BindingFlags.Public | BindingFlags.Static);
            if (e == null)
            {
                Debug.LogWarning("[HOMELINE] MartisMenu has no event '" + eventName + "'");
                return;
            }
            e.AddEventHandler(null, handler);
        }

        void RemoveHandler(string eventName, Action handler)
        {
            if (handler == null) return;
            EventInfo e = menu.GetEvent(eventName, BindingFlags.Public | BindingFlags.Static);
            if (e != null) e.RemoveEventHandler(null, handler);
        }
    }
}
