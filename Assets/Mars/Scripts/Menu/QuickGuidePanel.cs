using System;
using System.Collections.Generic;
using NasaSpaceApp.HUD;
using UnityEngine;
using UnityEngine.UI;

namespace NasaSpaceApp.Menu
{
    /// <summary>
    /// QUICK GUIDE panel: the ten-second "what to press" page the title opens once per app run (F2 opens it again).
    /// One intro line, then five rows, each with a picture of the simulator, a title, its key chips and one short
    /// description. The keys are the live ones of <see cref="KeybindCatalog"/> where it lists the action, else the
    /// shipped defaults. Built once and static: nothing scrolls, nothing ticks. Focus stays on the host's close
    /// button, labelled GOT IT.
    /// </summary>
    public sealed class QuickGuidePanel : MenuPanel
    {
        private const string PictureFolder = MenuAssets.Root + "Guide/";

        private const string IntroText =
            "Plan a route in MISSION PLAN and send it to MARVIS: the EVA starts and walks the route by itself.";
        private const string IntroShort =       // used when the full sentence does not fit one line
            "Plan a route in MISSION PLAN and send it to MARVIS: the EVA walks it by itself.";
        private const string FootText = "ESC pauses. F1 lists every key. F2 opens this guide again.";

        private const float PictureWidth = 176f, PictureHeight = 88f;    // 2:1 like the renders
        private const float Frame = 1f;                                  // Hairline border around a picture
        private const float RowHeight = PictureHeight + 2f * Frame;
        private const float TextX = PictureWidth + 2f * Frame + 18f;     // text column, right of the picture
        private const float TextInset = 10f;                             // row top to the title line
        private const float KeysAfterTitle = 16f;                        // longest title to the key chips
        private const float NoteGap = 12f;                               // after a "HOLD" note, before the next chip
        private const float DescriptionGap = 7f;                         // title line to the description
        private const float IntroGap = 14f, MinRowGap = 4f, MaxRowGap = 14f;
        private const float FootHeight = 18f, FootGap = 10f, BottomPad = 2f;

        private static readonly Vector2 TopLeft = new Vector2(0f, 1f);

        private struct Row
        {
            public string Picture, Title, Note, Body;
            public string[] Keys;
        }

        /// <summary>Creates the panel; nothing is built until <see cref="Build"/>.</summary>
        public QuickGuidePanel()
        {
        }

        public override string Title => "QUICK GUIDE";

        public override string BackLabel => "GOT IT";

        public override void Build(MenuContext ctx, RectTransform content)
        {
            MenuAssets a = ctx.Assets;
            float width = MenuTokens.ContentWidth, height = MenuTokens.ContentHeight;
            Row[] rows = Rows();

            string introText = MenuWidgets.TextWidth(a.Regular, MenuTokens.SizeSmall, IntroText) <= width - 2f
                ? IntroText
                : IntroShort;
            Text intro = MenuUi.Paragraph("Intro", content, a.Regular, MenuTokens.SizeSmall, MenuTokens.Sand,
                                          TextAnchor.UpperLeft, TopLeft, TopLeft, Vector2.zero,
                                          new Vector2(width, MenuTokens.SizeSmall), introText);
            float introHeight = Mathf.Ceil(intro.preferredHeight);
            intro.rectTransform.sizeDelta = new Vector2(width, introHeight);

            // The rows share what is left between the intro and the foot line.
            float rowsTop = introHeight + IntroGap;
            float footTop = height - BottomPad - FootHeight;
            float spare = footTop - FootGap - rowsTop - rows.Length * RowHeight;
            float gap = Mathf.Clamp(Mathf.Floor(spare / (rows.Length - 1)), MinRowGap, MaxRowGap);

            // Key chips start after the longest title, so they line up down the page.
            float titleWidth = 0f;
            for (int i = 0; i < rows.Length; i++)
            {
                titleWidth = Mathf.Max(titleWidth, MenuWidgets.TextWidth(a.Bold, MenuTokens.SizeTab, rows[i].Title));
            }
            float keysX = TextX + Mathf.Ceil(titleWidth) + KeysAfterTitle;

            float y = rowsTop;
            for (int i = 0; i < rows.Length; i++)
            {
                BuildRow(ctx, content, rows[i], y, keysX);
                y += RowHeight + gap;
            }

            // Only when the rows left room for it (a wrapped intro on an odd font can use it up).
            float rowsBottom = y - gap;
            if (rowsBottom + MinRowGap <= footTop)
            {
                MenuUi.Label("Foot", content, a.Regular, MenuTokens.SizeHint, MenuTokens.SandFaint, TextAnchor.MiddleLeft,
                             TopLeft, TopLeft, new Vector2(0f, -footTop), new Vector2(width, FootHeight), FootText);
            }
        }

        // The five rows with their keys; the sentences that name a rebindable key use its current label.
        private static Row[] Rows()
        {
            List<KeybindCatalog.Group> groups = null;
            try
            {
                groups = KeybindCatalog.Read();
            }
            catch (Exception e)
            {
                // The guide still opens, with the shipped keys.
                Debug.LogException(e);
            }

            var move = new List<string>(8);
            move.AddRange(Keys(groups, "MOVE") ?? new[] { "W", "A", "S", "D" });
            move.Add("MOUSE");
            move.Add(FirstKey(groups, "RUN (HOLD)", "L-SHIFT"));
            move.Add(FirstKey(groups, "JUMP", "SPACE"));

            string[] walk = GroupKeys(groups, "AUTO WALK") ?? GroupKeys(groups, "MISSION PLAN")
                            ?? new[] { "V", "T", "[", "]", "R" };
            string scan = FirstKey(groups, "SCAN ROCK (HOLD)", "E");
            string close = FirstKey(groups, "CLOSE ROCK CARD", "X");
            string time = FirstKey(groups, "NEXT TIME OF DAY", "N");
            string weather = FirstKey(groups, "NEXT WEATHER", "M");

            return new[]
            {
                new Row
                {
                    Picture = "guide_walk",
                    Title = "MOVE AND LOOK",
                    Keys = move.ToArray(),
                    Body = "Walk, look around, run and jump. You start at HOME.",
                },
                new Row
                {
                    Picture = "guide_autowalk",
                    Title = "AUTO WALK",
                    Keys = walk,
                    Body = "V takes the controls and gives them back. T pauses, [ ] change the speed, R hides the route line.",
                },
                new Row
                {
                    Picture = "guide_map",
                    Title = "EVA MAP",
                    Keys = Keys(groups, "EVA MAP") ?? new[] { "G" },
                    Body = "Route, terrain, mineral and weather layers.",
                },
                new Row
                {
                    Picture = "guide_scan",
                    Title = "SCAN A ROCK",
                    Keys = new[] { scan, close },
                    Note = "HOLD",
                    Body = "Hold " + scan + " on a rock for its chemistry card. " + close + " closes it.",
                },
                new Row
                {
                    Picture = "guide_weather",
                    Title = "SKY AND WEATHER",
                    Keys = new[] { time, weather },
                    Body = time + ": next time of day. " + weather
                           + ": next weather. Weather events also arrive on their own (SETTINGS, SIMULATION).",
                },
            };
        }

        // One row at y (px below the content top): framed picture, then title and key chips on one line and the
        // description under them.
        private static void BuildRow(MenuContext ctx, RectTransform content, Row row, float y, float keysX)
        {
            MenuAssets a = ctx.Assets;
            float width = MenuTokens.ContentWidth;
            RectTransform rt = HudFactory.CreateRect("Row " + row.Title, content, TopLeft, TopLeft, new Vector2(0f, -y),
                                                     new Vector2(width, RowHeight));

            // A missing picture leaves its place empty: the text keeps its column, so the rows stay aligned.
            Texture2D picture = Resources.Load<Texture2D>(PictureFolder + row.Picture);
            if (picture != null)
            {
                HudFactory.CreateImage("Frame", rt, null, MenuTokens.Hairline, TopLeft, TopLeft, Vector2.zero,
                                       new Vector2(PictureWidth + 2f * Frame, RowHeight));
                RectTransform pictureRect = HudFactory.CreateRect("Picture", rt, TopLeft, TopLeft, new Vector2(Frame, -Frame),
                                                                  new Vector2(PictureWidth, PictureHeight));
                var raw = pictureRect.gameObject.AddComponent<RawImage>();
                raw.texture = picture;
                raw.color = Color.white;
                raw.raycastTarget = false;
            }

            MenuUi.Label("Title", rt, a.Bold, MenuTokens.SizeTab, MenuTokens.Bronze, TextAnchor.MiddleLeft, TopLeft, TopLeft,
                         new Vector2(TextX, -TextInset), new Vector2(Mathf.Max(1f, keysX - TextX), MenuTokens.KeycapHeight),
                         row.Title);

            float x = keysX;
            bool first = true;
            for (int i = 0; i < row.Keys.Length; i++)
            {
                if (string.IsNullOrEmpty(row.Keys[i]))
                {
                    continue;
                }
                string key = row.Keys[i].ToUpperInvariant();
                float chip = MenuUi.KeycapWidth(key);
                if (x + chip > width)
                {
                    break;   // a rebound key with a long name: never past the panel edge
                }
                MenuUi.Keycap("Key " + key, rt, ctx, key, TopLeft, TopLeft, new Vector2(x, -TextInset));
                x += chip + MenuTokens.KeycapGap;

                if (first && !string.IsNullOrEmpty(row.Note))
                {
                    Text note = MenuUi.Label("Note", rt, a.Regular, MenuTokens.SizeHint, MenuTokens.SandDim,
                                             TextAnchor.MiddleLeft, TopLeft, TopLeft, new Vector2(x, -TextInset),
                                             new Vector2(0f, MenuTokens.KeycapHeight), row.Note);
                    float noteWidth = Mathf.Ceil(note.preferredWidth);
                    note.rectTransform.sizeDelta = new Vector2(noteWidth, MenuTokens.KeycapHeight);
                    x += noteWidth + NoteGap;
                }
                first = false;
            }

            float textY = TextInset + MenuTokens.KeycapHeight + DescriptionGap;
            MenuUi.Paragraph("Text", rt, a.Regular, MenuTokens.SizeSmall, MenuTokens.SandDim, TextAnchor.UpperLeft,
                             TopLeft, TopLeft, new Vector2(TextX, -textY), new Vector2(width - TextX, RowHeight - textY),
                             row.Body);
        }

        // Keys of the first catalog row named action, or null when the catalog does not list it.
        private static string[] Keys(List<KeybindCatalog.Group> groups, string action)
        {
            if (groups == null)
            {
                return null;
            }
            for (int g = 0; g < groups.Count; g++)
            {
                List<KeybindCatalog.Binding> rows = groups[g].Rows;
                for (int r = 0; r < rows.Count; r++)
                {
                    string[] keys = rows[r].Keys;
                    if (rows[r].Action == action && keys != null && keys.Length > 0)
                    {
                        return keys;
                    }
                }
            }
            return null;
        }

        private static string FirstKey(List<KeybindCatalog.Group> groups, string action, string fallback)
        {
            string[] keys = Keys(groups, action);
            return keys != null && !string.IsNullOrEmpty(keys[0]) ? keys[0] : fallback;
        }

        // Every key of the catalog group named title, in row order, or null when the group is not listed.
        private static string[] GroupKeys(List<KeybindCatalog.Group> groups, string title)
        {
            if (groups == null)
            {
                return null;
            }
            for (int g = 0; g < groups.Count; g++)
            {
                if (groups[g].Title != title)
                {
                    continue;
                }
                var keys = new List<string>(8);
                List<KeybindCatalog.Binding> rows = groups[g].Rows;
                for (int r = 0; r < rows.Count; r++)
                {
                    if (rows[r].Keys != null)
                    {
                        keys.AddRange(rows[r].Keys);
                    }
                }
                return keys.Count > 0 ? keys.ToArray() : null;
            }
            return null;
        }
    }
}
