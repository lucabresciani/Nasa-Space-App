/*
 * MARVIS page script.
 *
 * MarvisWeb.exe (WebView2) runs this file in every document of the route planner, before the
 * page's own scripts (--inject). The planner site knows nothing about MARVIS and is not changed.
 *
 * What it does, in the top document only:
 *   1. shows the product name MARVIS wherever the site shows its own upper-case name
 *   2. adds a small overlay in one shadow root: the "Back to MARVIS menu" button (F10), the
 *      "Start EVA in MARVIS" button, toasts, and the EVA debrief panel with its "Last EVA" chip
 *   3. reloads the page when the site has a newer version
 *   4. turns clicks on .json links into downloads (the viewer captures downloads)
 *   5. sends a mission to the game, but only while sending is armed: for 15 s after "Start EVA in
 *      MARVIS" (which clicks the site's own export control) or after the user clicks a "Send to
 *      simulator" control of the site. While armed, the next Blob download the page starts is read
 *      and, if it is a mission, posted to the game instead of saved. Not armed, nothing is touched:
 *      the site's "Download mission.json" is a plain download.
 *   6. handles the messages of the game, and says hello to it
 *
 * It uses nothing of the site but the visible label of its export control ("Download mission.json",
 * "Send to simulator"): no selectors of its elements, no reading of its state.
 * On the game's own local copy (it answers /marvis/api/hello) only 1, the toasts, 4, 5 and 6 run:
 * that copy has its own menu button and debrief, so the dock (and its Start EVA button) stays hidden.
 *
 * Messages: window.chrome.webview (a test may set window.__MARVIS_TEST_WEBVIEW).
 *   page -> game, wv.postMessage(object):
 *     { type: 'hello', inject: 1, url, bridge }     once, when the page is ready
 *     { type: 'close' }                             "Back to MARVIS menu" or F10
 *     { type: 'reloading', reason: 'update' }       just before an update reload
 *     { type: 'mission', name, text }               a mission to start: file name and JSON text
 *   game -> page, 'message' events (an object or its JSON):
 *     { type: 'eva-log', eva, log }                 show the EVA debrief
 *     { type: 'mission-error', error }              error toast
 *     { type: 'toast', text, level }                level 'error' or anything else
 *     { type: 'saved', name }                       "Saved to your Downloads folder"
 *     { type: 'blocked' }                           a link to another site was not opened
 *     { type: 'check-update' }                      look for a newer version of the site now
 *     { type: 'test-download', name, text }         a plain download, as the site does it (not armed)
 *     { type: 'test-send', name, text }             arm, then the same download: becomes 'mission'
 */
(function () {
  'use strict';

  // ======================= SETTINGS: edit, save, start the game again (no rebuild) =======================
  // This file sits next to MarvisWeb.exe (folder MarvisWeb of the game); its source is Tools/marvis-web/live.
  //
  // START_EVA_BUTTON   true  = this script shows its own "Start EVA in MARVIS" button.
  //                    false = no such button: for when the planner site has a send button of its own.
  //                    Either way, a button of the site whose label matches SEND_LABEL starts the EVA,
  //                    and the site's "Download mission.json" stays a plain download.
  const START_EVA_BUTTON = false;
  // The site's export control that "Start EVA in MARVIS" presses, found by its visible label.
  const EXPORT_LABEL = /download mission\.json|send to (the )?simulator/i;
  // Buttons of the site that start the EVA when the user presses them (the file they produce is sent
  // to the game, not saved), found by their visible label.
  const SEND_LABEL = /send to (the )?(simulator|unity|marvis)/i;
  // =======================================================================================================

  try {
    if (window.top !== window) return; // top document only
    const wv = (window.chrome && window.chrome.webview) || window.__MARVIS_TEST_WEBVIEW;
    if (!wv || window.__marvisInject) return;
    window.__marvisInject = 1;

    // Nothing here may throw into the page.
    const safe = (fn) =>
      function () {
        try {
          return fn.apply(this, arguments);
        } catch (e) {
          return undefined;
        }
      };
    const post = safe((m) => wv.postMessage(m));

    const store = (s) => ({
      get: (k) => {
        try {
          return window[s].getItem(k);
        } catch (e) {
          return null;
        }
      },
      // true only when the value is really stored
      set: (k, v) => {
        try {
          window[s].setItem(k, v);
          return window[s].getItem(k) === v;
        } catch (e) {
          return false;
        }
      },
      del: (k) => {
        try {
          window[s].removeItem(k);
        } catch (e) {
          /* no storage */
        }
      },
    });
    const session = store('sessionStorage');
    const local = store('localStorage');
    const K_RELOADED = 'marvis.reloadedFor'; // Last-Modified value the page was last reloaded for
    const K_UPDATED = 'marvis.updated'; // set just before an update reload
    const K_LOG = 'marvis.evalog'; // last EVA log (summary only), kept across reloads
    const K_DOCK = 'marvis.dock'; // where the user dragged the menu button

    let host = null; // the overlay's host element, a child of <html>
    let root = null; // its shadow root
    let dock, chip, panel, panelBody, panelClose, toasts;

    const domReady = new Promise((res) => {
      if (document.readyState !== 'loading') res();
      else document.addEventListener('DOMContentLoaded', () => res(), { once: true });
    });

    // ---------------------------------------------------------------- 1. product name

    const NAME = /\bHOMELINE\b/g;
    const ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];
    const SKIP = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1 };
    const fixName = (s) => (typeof s === 'string' && s.indexOf('HOMELINE') !== -1 ? s.replace(NAME, 'MARVIS') : s);

    function fixText(t) {
      const v = t.nodeValue;
      if (!v || v.indexOf('HOMELINE') === -1) return;
      const p = t.parentNode;
      if (p && p.nodeType === 1 && (SKIP[p.nodeName.toUpperCase()] || p.isContentEditable)) return;
      const n = v.replace(NAME, 'MARVIS');
      if (n !== v) t.nodeValue = n; // a right value is never written again: no loop
    }

    function fixAttrs(e) {
      for (let i = 0; i < ATTRS.length; i++) {
        const v = e.getAttribute(ATTRS[i]);
        if (v && v.indexOf('HOMELINE') !== -1) {
          const n = v.replace(NAME, 'MARVIS');
          if (n !== v) e.setAttribute(ATTRS[i], n);
        }
      }
    }

    function fixTree(n) {
      if (n.nodeType === 3) {
        fixText(n);
        return;
      }
      if (n === host || (n.nodeType !== 1 && n.nodeType !== 9)) return;
      if (n.nodeType === 1) fixAttrs(n);
      const w = document.createTreeWalker(n, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
      for (let c = w.nextNode(); c; c = w.nextNode()) {
        if (c.nodeType === 3) fixText(c);
        else fixAttrs(c);
      }
    }

    // Mutation records are delivered before the next paint, so the site's name is never seen.
    // The overlay lives in a shadow root, which this observer does not see.
    new MutationObserver(
      safe((list) => {
        for (let i = 0; i < list.length; i++) {
          const m = list[i];
          if (m.type === 'childList') for (let j = 0; j < m.addedNodes.length; j++) fixTree(m.addedNodes[j]);
          else if (m.type === 'characterData') fixText(m.target);
          else fixAttrs(m.target);
        }
        if (host && !host.isConnected) mount(); // the page replaced the children of <html>
      }),
    ).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    fixTree(document);

    // ---------------------------------------------------------------- 2. overlay

    // Colours, type and radii are the site's own design tokens, copied by value.
    const CSS = `
:host { all: initial; }
.m {
  --bg: #0C1211; --surface: #111A19; --raised: #202A27; --line: #2C3834; --line-strong: #46544F;
  --text: #E6EDF3; --muted: #9AA7A3; --ok: #3DD68C; --warn: #FB923C; --bad: #F43F5E; --info: #9FD3FF;
  --sans: "Inter", system-ui, -apple-system, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --ease-out: cubic-bezier(0.23, 1, 0.32, 1);
  --shadow: 0 16px 40px -8px rgba(2, 6, 5, 0.72), 0 2px 6px rgba(2, 6, 5, 0.4);
  font: 400 14px/20px var(--sans); letter-spacing: normal; text-align: left; color: var(--text);
  -webkit-font-smoothing: antialiased; color-scheme: dark;
}
.m *, .m *::before, .m *::after { box-sizing: border-box; }
.m ::selection { background: var(--line-strong); color: var(--text); }
[hidden] { display: none !important; }

button {
  appearance: none; margin: 0; font: inherit; color: var(--text); cursor: pointer;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
}
button:focus-visible { outline: 2px solid var(--text); outline-offset: 2px; }

/* The Last EVA chip, the menu button and the Start EVA button */
.dock {
  position: fixed; top: 8px; right: 144px; display: flex; align-items: center; gap: 8px;
  pointer-events: auto; user-select: none; -webkit-user-select: none; touch-action: none;
}
.btn {
  display: inline-flex; align-items: center; gap: 8px; height: 32px; padding: 0 8px;
  border: 1px solid var(--line); border-radius: 4px; background: var(--surface);
  font-weight: 500; white-space: nowrap;
  transition: background-color 100ms ease, border-color 100ms ease, transform 120ms var(--ease-out);
}
.btn svg { flex: none; color: var(--muted); }
.btn:active { transform: scale(0.97); }
/* The main action: the neutral button inverted, from the same two tokens */
.btn.primary { padding: 0 12px 0 8px; background: var(--text); border-color: var(--text); color: var(--bg); font-weight: 600; }
.btn.primary svg { color: inherit; }
.chip { height: 24px; padding: 0 10px; border-radius: 999px; font-size: 12px; line-height: 16px; color: var(--muted); }
.chip[aria-expanded="true"] { background: var(--raised); border-color: var(--line-strong); color: var(--text); }
kbd {
  font: 400 12px/16px var(--mono); letter-spacing: 0.06em; color: var(--muted);
  padding: 0 4px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg);
}
.dragging, .dragging .btn { cursor: grabbing; }
.dragging .btn { transition: none; transform: none; }

/* Icon-only close buttons */
.x {
  flex: none; display: grid; place-items: center; width: 28px; height: 28px; padding: 0;
  border: 0; border-radius: 4px; background: transparent; color: var(--muted);
  transition: background-color 100ms ease, color 100ms ease;
}

@media (hover: hover) and (pointer: fine) {
  .btn:hover { background: var(--raised); border-color: var(--line-strong); color: var(--text); }
  .btn.primary:hover { background: #FBFDFE; border-color: #FBFDFE; color: var(--bg); }
  .x:hover { background: var(--raised); color: var(--text); }
}

/* EVA debrief: opens from the dock, so it grows from its top right corner */
.panel {
  position: fixed; top: 48px; right: 144px; width: min(380px, calc(100vw - 16px));
  max-height: calc(100vh - 16px); overflow: auto; padding: 12px 16px 16px;
  background: var(--surface); border: 1px solid var(--line); border-radius: 8px; box-shadow: var(--shadow);
  pointer-events: auto; overscroll-behavior: contain; scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent;
  visibility: hidden; opacity: 0; transform: translateY(-6px) scale(0.98); transform-origin: top right;
  transition: opacity 140ms ease-out, transform 140ms ease-out, visibility 0s linear 140ms;
}
.panel.open {
  visibility: visible; opacity: 1; transform: none;
  transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out), visibility 0s;
}
.panel.above { transform-origin: bottom right; }
.head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-right: -8px; }
h2 { margin: 0; font: 600 12px/16px var(--sans); letter-spacing: 0.06em; text-transform: uppercase; }
.source { margin: 8px 0 0; }
.tag {
  display: inline-block; padding: 1px 6px; border: 1px solid rgba(159, 211, 255, 0.45); border-radius: 4px;
  font: 600 11px/14px var(--sans); letter-spacing: 0.06em; text-transform: uppercase; color: var(--info);
}
.origin { display: block; margin-top: 4px; font-size: 12px; line-height: 16px; color: var(--muted); overflow-wrap: anywhere; text-wrap: pretty; }
dl { display: grid; gap: 4px; margin: 12px 0 0; }
.row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
dt { color: var(--muted); }
dd { min-width: 0; margin: 0; font-weight: 600; text-align: right; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.row.ok dd { color: var(--ok); }
.row.warn dd { color: var(--warn); }
.row.bad dd { color: var(--bad); }
.note {
  margin: 12px 0 0; padding-top: 12px; border-top: 1px solid var(--line);
  font-size: 12px; line-height: 16px; color: var(--muted); overflow-wrap: anywhere; text-wrap: pretty;
}

/* Toasts: in and out through the top edge, under the site's top bar */
.toasts {
  position: fixed; top: 56px; left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: column; align-items: center; gap: 8px;
  width: max-content; max-width: min(440px, calc(100vw - 32px)); pointer-events: none;
}
.toast {
  display: flex; align-items: flex-start; gap: 8px; max-width: 100%; padding: 6px 6px 6px 12px;
  background: var(--raised); border: 1px solid var(--line-strong); border-radius: 8px; box-shadow: var(--shadow);
  pointer-events: auto; opacity: 0; transform: translateY(-8px);
  transition: opacity 150ms ease-out, transform 150ms ease-out;
}
.toast.in { opacity: 1; transform: none; transition: opacity 200ms var(--ease-out), transform 200ms var(--ease-out); }
.toast.error { border-color: rgba(244, 63, 94, 0.6); }
.toast > svg { flex: none; margin-top: 6px; color: var(--info); }
.toast.error > svg { color: var(--bad); }
.toast > span { flex: 1; min-width: 0; padding: 4px 0; overflow-wrap: anywhere; text-wrap: balance; }

/* Reduced motion: keep the fades, drop the movement */
@media (prefers-reduced-motion: reduce) {
  .panel, .panel.open, .toast, .toast.in, .btn:active { transform: none; }
}
`;

    const SVG_NS = 'http://www.w3.org/2000/svg';
    // 24 x 24 stroke icons in the style of the site's icon set
    const ICON = {
      back: ['m15 18-6-6 6-6'],
      play: ['M6 3l14 9-14 9z'],
      close: ['M18 6 6 18', 'm6 6 12 12'],
      info: ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'M12 16v-4', 'M12 8h.01'],
      error: ['M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0', 'M12 8v4', 'M12 16h.01'],
    };

    function el(tag, attrs, kids) {
      const e = document.createElement(tag);
      for (const k in attrs || {}) {
        if (k === 'text') e.textContent = attrs[k];
        else e.setAttribute(k, attrs[k]);
      }
      (kids || []).forEach((c) => c && e.appendChild(c));
      return e;
    }

    function icon(name) {
      const s = document.createElementNS(SVG_NS, 'svg');
      const a = { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' };
      for (const k in a) s.setAttribute(k, a[k]);
      ICON[name].forEach((d) => {
        const p = document.createElementNS(SVG_NS, 'path');
        p.setAttribute('d', d);
        s.appendChild(p);
      });
      return s;
    }

    function build() {
      host = document.createElement('marvis-overlay');
      // A zero-size fixed box above everything; set through the CSSOM so that a CSP cannot block it.
      [['all', 'initial'], ['position', 'fixed'], ['top', '0'], ['left', '0'], ['width', '0'], ['height', '0'], ['z-index', '2147483647'], ['pointer-events', 'none']].forEach((p) =>
        host.style.setProperty(p[0], p[1], 'important'),
      );
      root = host.attachShadow({ mode: 'open' });
      try {
        const sheet = new CSSStyleSheet();
        sheet.replaceSync(CSS);
        root.adoptedStyleSheets = [sheet];
      } catch (e) {
        root.appendChild(el('style', { text: CSS }));
      }

      chip = el('button', { type: 'button', class: 'btn chip', 'aria-expanded': 'false', title: 'Show the debrief of the last EVA', text: 'Last EVA', hidden: '' });
      const menu = el('button', { type: 'button', class: 'btn', 'aria-keyshortcuts': 'F10', title: 'Close the planner and go back to the MARVIS menu (F10). To move this button, drag it or press Shift with an arrow key.' }, [
        icon('back'),
        el('span', { text: 'Back to MARVIS menu' }),
        el('kbd', { text: 'F10' }),
      ]);
      const start = el('button', { type: 'button', class: 'btn primary', title: 'Send the route planned here to MARVIS and start the EVA' }, [
        icon('play'),
        el('span', { text: 'Start EVA in MARVIS' }),
      ]);
      // START_EVA_BUTTON false: the button is simply not in the dock (see SETTINGS at the top of this file).
      dock = el('div', { class: 'dock', role: 'group', 'aria-label': 'MARVIS', hidden: '' }, START_EVA_BUTTON ? [chip, menu, start] : [chip, menu]);

      panelClose = el('button', { type: 'button', class: 'x', 'aria-label': 'Close the EVA debrief', title: 'Close' }, [icon('close')]);
      panelBody = el('div');
      panel = el('section', { class: 'panel', role: 'dialog', 'aria-modal': 'false', 'aria-label': 'EVA debrief' }, [
        el('div', { class: 'head' }, [el('h2', { text: 'EVA debrief' }), panelClose]),
        panelBody,
      ]);

      toasts = el('div', { class: 'toasts' });
      root.appendChild(el('div', { class: 'm', translate: 'no' }, [dock, panel, toasts]));

      menu.addEventListener('click', safe(() => post({ type: 'close' })));
      start.addEventListener('click', safe(startEva)); // after a drag the dock stops the click, as for the menu button
      chip.addEventListener('click', safe(() => (panel.classList.contains('open') ? closePanel() : openPanel(true))));
      panelClose.addEventListener('click', safe(closePanel));
      panel.addEventListener(
        'keydown',
        safe((e) => {
          if (e.key !== 'Escape') return;
          e.stopPropagation();
          closePanel();
        }),
      );
      dragDock();
      window.addEventListener(
        'resize',
        safe(() => {
          setDock(want.r, want.t);
          if (panel.classList.contains('open')) placePanel();
        }),
      );
    }

    /** Puts the overlay in the page (again, if the page removed it). False while there is no <html> yet. */
    function mount() {
      if (!document.documentElement) return false;
      if (!host) build();
      if (!host.isConnected) document.documentElement.appendChild(host);
      return true;
    }

    // ---- the menu button can be dragged away if it ever covers something of the site

    let want = { r: 144, t: 8 }; // distance from the right and top edges, as chosen
    const saved = safe(() => JSON.parse(local.get(K_DOCK)))();
    if (saved && typeof saved.r === 'number' && typeof saved.t === 'number' && isFinite(saved.r + saved.t)) want = { r: saved.r, t: saved.t };

    function setDock(right, top) {
      const r = Math.max(4, Math.min(right, window.innerWidth - dock.offsetWidth - 4));
      const t = Math.max(4, Math.min(top, window.innerHeight - dock.offsetHeight - 4));
      dock.style.right = r + 'px';
      dock.style.top = t + 'px';
    }

    function dragDock() {
      let from = null;
      let dragged = false;
      // The pointer is followed on the window: a fast move leaves the button before the drag starts.
      const move = safe((e) => {
        if (!from || e.pointerId !== from.id) return;
        if (!(e.buttons & 1)) {
          end(); // the button was released outside the window
          return;
        }
        const dx = e.clientX - from.x;
        const dy = e.clientY - from.y;
        if (!from.on) {
          if (Math.abs(dx) + Math.abs(dy) < 6) return; // still a click
          from.on = true;
          dock.classList.add('dragging');
          safe(() => dock.setPointerCapture(e.pointerId))();
        }
        want = { r: from.r - dx, t: from.t + dy };
        setDock(want.r, want.t);
        if (panel.classList.contains('open')) placePanel();
      });
      const end = safe(() => {
        window.removeEventListener('pointermove', move, true);
        window.removeEventListener('pointerup', end, true);
        window.removeEventListener('pointercancel', end, true);
        if (from && from.on) {
          dock.classList.remove('dragging');
          local.set(K_DOCK, JSON.stringify(want));
          dragged = true; // the click that ends a drag is not a click on the button
          setTimeout(() => (dragged = false), 0);
        }
        from = null;
      });
      dock.addEventListener(
        'pointerdown',
        safe((e) => {
          if (e.button !== 0 || from) return;
          const b = dock.getBoundingClientRect();
          from = { id: e.pointerId, x: e.clientX, y: e.clientY, r: window.innerWidth - b.right, t: b.top, on: false };
          window.addEventListener('pointermove', move, true);
          window.addEventListener('pointerup', end, true);
          window.addEventListener('pointercancel', end, true);
        }),
      );
      // The same with the keyboard: Shift and an arrow key.
      dock.addEventListener(
        'keydown',
        safe((e) => {
          const step = { ArrowLeft: [16, 0], ArrowRight: [-16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] }[e.key];
          if (!step || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
          e.preventDefault();
          e.stopPropagation();
          const b = dock.getBoundingClientRect();
          want = { r: window.innerWidth - b.right + step[0], t: b.top + step[1] };
          setDock(want.r, want.t);
          local.set(K_DOCK, JSON.stringify(want));
          if (panel.classList.contains('open')) placePanel();
        }),
      );
      dock.addEventListener(
        'click',
        (e) => {
          if (!dragged) return;
          dragged = false;
          e.stopPropagation();
          e.preventDefault();
        },
        true,
      );
    }

    // ---- toasts

    function dismiss(t) {
      if (t._gone) return;
      t._gone = true;
      clearTimeout(t._timer);
      t.classList.remove('in');
      const drop = () => t.remove();
      t.addEventListener('transitionend', drop, { once: true });
      setTimeout(drop, 300);
    }

    // The time runs only while the page is visible and the toast is neither hovered nor focused.
    function arm(t) {
      clearTimeout(t._timer);
      t._timer = setTimeout(() => {
        if (document.hidden || t.matches(':hover, :focus-within')) t._late = true;
        else dismiss(t);
      }, t._ms);
    }
    const rearm = safe(() => {
      if (!toasts || document.hidden) return;
      Array.prototype.forEach.call(toasts.children, (t) => {
        if (!t._late || t._gone || t.matches(':hover, :focus-within')) return;
        t._late = false;
        arm(t);
      });
    });
    document.addEventListener('visibilitychange', rearm);

    /** Errors stay 10 s and are announced at once; the rest stays 5 s. */
    function toast(text, level) {
      const error = level === 'error';
      const words = fixName(String(text == null ? '' : text)).trim();
      if (!words) return; // nothing to say
      domReady.then(
        safe(() => {
          if (!mount()) return;
          while (toasts.children.length >= 4) toasts.firstChild.remove();
          const msg = el('span');
          const x = el('button', { type: 'button', class: 'x', 'aria-label': 'Dismiss', title: 'Dismiss' }, [icon('close')]);
          const t = el('div', { class: error ? 'toast error' : 'toast', role: error ? 'alert' : 'status', 'aria-live': error ? 'assertive' : 'polite' }, [icon(error ? 'error' : 'info'), msg, x]);
          t._ms = error ? 10000 : 5000;
          x.addEventListener('click', safe(() => dismiss(t)));
          t.addEventListener('pointerleave', rearm);
          t.addEventListener('focusout', () => setTimeout(rearm, 0));
          toasts.appendChild(t);
          msg.textContent = words; // after the live region exists
          void t.offsetWidth; // start state first, then the transition
          t.classList.add('in');
          arm(t);
        }),
      );
    }

    // ---- EVA debrief: the game's own numbers from its EVA log, shown as they are. Nothing is computed.

    let lastLog = null; // { eva, log }
    const isNum = (v) => typeof v === 'number' && isFinite(v);
    /** A logged value with its unit, a dash when the log does not have it. */
    const num = (v, digits, unit) => (isNum(v) ? v.toFixed(digits) + ' ' + unit : '–');
    const text = (v) => (typeof v === 'string' && v ? fixName(v) : '');

    function row(k, v, cls, title) {
      const a = { class: cls ? 'row ' + cls : 'row' };
      if (title) a.title = title;
      return el('div', a, [el('dt', { text: k }), el('dd', { text: v })]);
    }

    function renderLog() {
      const log = lastLog && lastLog.log && typeof lastLog.log === 'object' ? lastLog.log : {};
      const s = log.summary && typeof log.summary === 'object' ? log.summary : {};
      const complete = typeof s.complete === 'boolean' ? s.complete : lastLog.eva === 'complete' ? true : lastLog.eva === 'ended' ? false : null;
      const ended = Array.isArray(log.events) ? log.events.filter((e) => e && e.kind === 'end')[0] : null;
      const endReason = complete === false && ended ? text(ended.detail) : '';
      const o2Model = text(log.o2_model);
      const margin = s.lowest_margin_min;
      const count = (v) => (isNum(v) ? String(v) : '–');
      const waypoints = !isNum(s.waypoints_done) && !isNum(s.waypoints_skipped) ? '–' : count(s.waypoints_done) + ' done, ' + count(s.waypoints_skipped) + ' skipped' + (isNum(s.stops_left_early) && s.stops_left_early > 0 ? ', ' + s.stops_left_early + ' left early' : '');

      const kids = [];
      if (text(log.label) || text(log.origin_label)) {
        kids.push(el('p', { class: 'source' }, [text(log.label) ? el('span', { class: 'tag', text: text(log.label) }) : null, text(log.origin_label) ? el('span', { class: 'origin', text: text(log.origin_label) }) : null]));
      }
      kids.push(
        el('dl', null, [
          complete === null ? row('Outcome', '–') : row('Outcome', complete ? 'Completed' : 'Ended early', complete ? 'ok' : 'warn', complete ? 'Back at the pad with every waypoint done or skipped' : endReason),
          row('EVA time', num(s.eva_min, 1, 'min') + ', planned ' + num(s.planned_eva_min, 1, 'min')),
          row('O₂ used', num(s.o2_used_l, 1, 'L') + ', planned ' + num(s.planned_o2_used_l, 1, 'L'), '', o2Model),
          row('Lowest margin', num(margin, 1, 'min') + (isNum(margin) && text(s.lowest_binding) ? ', bound by ' + text(s.lowest_binding) : ''), isNum(margin) ? (margin < 0 ? 'bad' : 'ok') : ''),
          row('Waypoints', waypoints),
          row('Largest cross-track distance', num(s.max_cross_track_m, 1, 'm'), '', 'Farthest the walk was from the route planned for this EVA'),
        ]),
      );
      const note = (text(log.title) ? text(log.title) + '. ' : '') + (endReason ? 'Ended: ' + endReason + '. ' : '') + (o2Model ? 'O₂ used is from the ' + o2Model + '.' : '');
      if (note.trim()) kids.push(el('p', { class: 'note', text: note.trim() }));

      while (panelBody.firstChild) panelBody.firstChild.remove();
      kids.forEach((k) => panelBody.appendChild(k));
    }

    /** Under the dock, right edges aligned; above it when there is no room below. Always inside the window. */
    function placePanel() {
      const d = dock.getBoundingClientRect();
      const h = panel.offsetHeight;
      const w = panel.offsetWidth;
      const below = d.bottom + 8;
      const above = below + h > window.innerHeight - 8 && d.top - 8 - h >= 8;
      const top = above ? d.top - 8 - h : Math.max(8, Math.min(below, window.innerHeight - h - 8));
      panel.classList.toggle('above', above);
      panel.style.top = top + 'px';
      panel.style.right = Math.max(8, Math.min(window.innerWidth - d.right, window.innerWidth - w - 8)) + 'px';
    }

    function keepLog() {
      if (!lastLog) return;
      const slim = {};
      for (const k in lastLog.log) if (k !== 'track' && k !== 'waypoints' && k !== 'events') slim[k] = lastLog.log[k];
      if (Array.isArray(lastLog.log.events)) slim.events = lastLog.log.events.filter((e) => e && e.kind === 'end');
      safe(() => session.set(K_LOG, JSON.stringify({ eva: lastLog.eva, log: slim, open: panel.classList.contains('open') })))();
    }

    function openPanel(focus) {
      placePanel();
      panel.classList.add('open');
      chip.setAttribute('aria-expanded', 'true');
      if (focus) panelClose.focus({ preventScroll: true });
      keepLog();
    }

    function closePanel() {
      const inside = root.activeElement && panel.contains(root.activeElement);
      panel.classList.remove('open');
      chip.setAttribute('aria-expanded', 'false');
      if (inside) chip.focus({ preventScroll: true });
      keepLog();
    }

    /** open: show the panel too. fresh: the log just came from the game (not kept from before a reload). */
    function showLog(eva, log, open, fresh) {
      if (bridge !== false || !mount()) return;
      lastLog = { eva: eva, log: log && typeof log === 'object' ? log : {} };
      renderLog();
      chip.hidden = false;
      setDock(want.r, want.t);
      // A fresh debrief takes the focus, but only when the page has none in use.
      if (open) openPanel(fresh && (!document.activeElement || document.activeElement === document.body));
      else keepLog();
    }

    // ---------------------------------------------------------------- 3. update check

    const canUpdate = /^https?:$/.test(location.protocol) && (location.protocol === 'https:' || location.hostname !== '127.0.0.1');
    let checking = false;

    function checkUpdate() {
      if (!canUpdate || checking) return;
      checking = true;
      fetch(location.pathname + '?marvis_t=' + Date.now(), { method: 'HEAD', cache: 'no-store' })
        .then((res) => {
          const lm = res.ok ? res.headers.get('Last-Modified') : null;
          if (!lm) return;
          if (!(Date.parse(lm) - new Date(document.lastModified).getTime() > 1000)) return;
          // Never twice for the same version; without storage there is no guard, so no reload.
          if (session.get(K_RELOADED) === lm || !session.set(K_RELOADED, lm)) return;
          session.set(K_UPDATED, lm);
          post({ type: 'reloading', reason: 'update' });
          location.reload();
        })
        .catch(() => {})
        .then(() => {
          checking = false;
        });
    }

    // ---------------------------------------------------------------- 4. .json links

    /** A file for the user. Under the rule of section 5: while sending is armed, a mission goes to the game. */
    function download(blob, name) {
      if (sendArmed()) take(blob, name);
      else plainDownload(blob, name);
    }

    window.addEventListener(
      'click',
      safe((e) => {
        if (e.defaultPrevented) return; // the page handles this link itself (its own Blob download)
        const path = e.composedPath ? e.composedPath() : [e.target];
        let a = null;
        for (let i = 0; i < path.length && !a; i++) if (path[i] && path[i].nodeType === 1 && path[i].localName === 'a') a = path[i];
        if (!a) return;
        const href = typeof a.href === 'string' ? a.href : a.href && a.href.baseVal;
        if (!href) return;
        const u = new URL(href, document.baseURI);
        if (!/^https?:$/.test(u.protocol) || !/\.json$/i.test(u.pathname)) return; // blob: downloads pass through
        e.preventDefault(); // a .json link never replaces the planner
        let name = a.getAttribute('download') || u.pathname.split('/').pop();
        name = safe(() => decodeURIComponent(name))() || name;
        fetch(u.href)
          .then((res) => {
            if (!res.ok) throw new Error('HTTP ' + res.status);
            return res.blob();
          })
          .then((blob) => download(blob, name))
          .catch((err) => toast('Could not download ' + name + (/^HTTP \d+$/.test(err && err.message) ? ' (' + err.message + '). Try again later.' : '. Check the connection and try again.'), 'error'));
      }),
      false, // after the page's own handlers: a link the page downloads itself is not downloaded twice
    );

    // ---------------------------------------------------------------- 5. the mission, to the game

    // The site downloads a mission as a Blob URL opened by a click on <a download>. That stays a plain
    // download, except while sending is armed: then the file is read here and a mission is posted to
    // the game. What arms: "Start EVA in MARVIS", and the user's click on a "Send to simulator" control.
    const ARM_MS = 15000;
    const EXPORT = EXPORT_LABEL; // what "Start EVA in MARVIS" clicks (SETTINGS, top of the file)
    const SEND = SEND_LABEL; // what arms when the user clicks it (SETTINGS, top of the file)
    const NO_MISSION = 'The planner did not produce a mission. Try again.';
    const urlCreate = URL.createObjectURL;
    const urlRevoke = URL.revokeObjectURL;
    const anchorClick = HTMLAnchorElement.prototype.click;
    const blobs = new Map(); // blob: URL -> Blob, the 20 newest
    let armedUntil = 0;
    let armTimer = 0; // runs when the user is to be told that no mission came
    let plain = false; // true during a download click of this script: never taken

    function sendArmed() {
      return Date.now() < armedUntil;
    }

    function disarmSend() {
      armedUntil = 0;
      clearTimeout(armTimer);
      armTimer = 0;
    }

    /** report: tell the user when the time runs out without a mission. */
    function armSend(report) {
      disarmSend();
      armedUntil = Date.now() + ARM_MS;
      if (!report) return;
      armTimer = setTimeout(
        safe(() => {
          disarmSend();
          toast(NO_MISSION, 'error');
        }),
        ARM_MS,
      );
    }

    /** A real download, the way the site does its own. The originals are used: this one is never taken. */
    function plainDownload(blob, name) {
      const url = urlCreate.call(URL, blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      (document.body || document.documentElement).appendChild(a);
      plain = true;
      try {
        anchorClick.call(a);
      } finally {
        plain = false;
      }
      a.remove();
      setTimeout(() => urlRevoke.call(URL, url), 60000);
    }

    /** A file caught while armed: a mission goes to the game, anything else is downloaded after all. */
    const take = safe((blob, name) => {
      const report = armTimer !== 0;
      disarmSend(); // first: the same click is never taken twice
      const other = safe(() => {
        plainDownload(blob, name || '');
        if (report) toast(NO_MISSION, 'error');
      });
      let read;
      try {
        read = blob.text();
      } catch (e) {
        read = Promise.reject(e);
      }
      read.then(
        safe((text) => {
          if (text.indexOf('homeline_mission') === -1) other();
          else post({ type: 'mission', name: name || 'mission.json', text: text });
        }),
        other,
      );
    });

    /** While armed: the Blob behind an <a download href="blob:..."> that is being clicked. Null otherwise. */
    function caught(a) {
      if (plain || !sendArmed() || !a || typeof a.hasAttribute !== 'function' || !a.hasAttribute('download')) return null;
      const href = a.href;
      return (typeof href === 'string' && href.indexOf('blob:') === 0 && blobs.get(href)) || null;
    }

    // The wrappers return what the originals return and add no error of their own.
    safe(() => {
      if (typeof urlCreate !== 'function' || typeof urlRevoke !== 'function' || typeof anchorClick !== 'function') return;
      URL.createObjectURL = function (obj) {
        const url = urlCreate.apply(this, arguments);
        try {
          if (typeof url === 'string' && obj instanceof Blob) {
            blobs.set(url, obj);
            if (blobs.size > 20) blobs.delete(blobs.keys().next().value);
          }
        } catch (e) {
          /* never into the page */
        }
        return url;
      };
      URL.revokeObjectURL = function (url) {
        const r = urlRevoke.apply(this, arguments);
        try {
          // The site revokes right after its click: the Blob stays readable a little longer.
          if (blobs.has(url)) setTimeout(() => blobs.delete(url), 30000);
        } catch (e) {
          /* never into the page */
        }
        return r;
      };
      // click() of an <a> that is not in the document sends no event to the window: caught here.
      HTMLAnchorElement.prototype.click = function () {
        let blob = null;
        try {
          blob = caught(this);
        } catch (e) {
          blob = null;
        }
        if (!blob) return anchorClick.apply(this, arguments);
        take(blob, this.getAttribute('download'));
        return undefined;
      };
    })();

    const labelOf = (e) => {
      const t = (e.textContent || '').trim();
      return t.length <= 60 ? t : ''; // a control, not a container of controls
    };
    const isOff = (e) => e.disabled === true || e.getAttribute('aria-disabled') === 'true';

    // Before the page's own handlers: clicks that reach an <a download> without going through click()
    // (a real click, a dispatched event), and the user's clicks on the site's "Send to simulator".
    window.addEventListener(
      'click',
      safe((e) => {
        const t = e.target;
        if (plain || !t || typeof t.closest !== 'function') return;
        const c = e.isTrusted ? t.closest('button, a, [role="button"]') : null;
        if (c && SEND.test(labelOf(c))) armSend(false); // first: the control can be the download link itself
        const a = t.closest('a[download]');
        const blob = a ? caught(a) : null;
        if (!blob) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        take(blob, a.getAttribute('download'));
      }),
      true,
    );

    /** The site's own export control, known by its visible label only. One that is not disabled comes first. */
    function exportControl() {
      const all = document.querySelectorAll('button, a, [role="button"]');
      let off = null;
      for (let i = 0; i < all.length; i++) {
        const c = all[i];
        if (!EXPORT.test(labelOf(c))) continue;
        const r = c.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0)) continue; // not rendered
        if (!isOff(c)) return c;
        if (!off) off = c;
      }
      return off;
    }

    /** "Start EVA in MARVIS": the site builds the mission as for its own download, and it is taken. */
    function startEva(e) {
      if (e && e.detail > 1) return; // the second click of a double click: one mission, not two
      const c = exportControl();
      if (!c) toast('This page of the planner has no mission to send. Open PLAN and build a route.', 'info');
      else if (isOff(c)) toast('Add at least one waypoint to the route first.', 'info');
      else {
        armSend(true);
        c.click();
      }
    }

    // ---------------------------------------------------------------- 6. the game

    // The game's own local copy is served on the loopback address only: anywhere else, do not even ask.
    let bridge = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname) ? null : false; // null = not known yet

    function askOnce(ms) {
      return new Promise((resolve) => {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), ms);
        fetch('/marvis/api/hello', { cache: 'no-store', signal: ac.signal })
          .then((res) => (res.ok ? res.json() : null))
          .then(
            (j) => resolve(!!j && j.app === 'MARVIS'),
            (e) => resolve(e && e.name === 'AbortError' ? null : false), // null = no answer in time
          )
          .then(() => clearTimeout(timer));
      });
    }

    // Any answer is final; only a timeout is asked again, with more patience (the game can be busy).
    const probed =
      bridge === false
        ? Promise.resolve()
        : askOnce(800)
            .then((r) => (r === null ? askOnce(2000) : r))
            .then((r) => (r === null ? askOnce(5000) : r))
            .then((r) => {
              bridge = r === true;
            });
    const boot = Promise.all([domReady, probed]);

    const onMessage = safe((d) => {
      if (typeof d === 'string') d = JSON.parse(d);
      if (!d || typeof d !== 'object') return;
      switch (d.type) {
        case 'eva-log':
          showLog(d.eva, d.log, true, true);
          break;
        case 'mission-error':
          toast('MARVIS did not start the EVA' + (d.error ? ': ' + d.error : '.'), 'error');
          break;
        case 'toast':
          toast(d.text, d.level === 'error' ? 'error' : 'info');
          break;
        case 'saved':
          toast('Saved to your Downloads folder: ' + d.name, 'info');
          break;
        case 'blocked':
          toast('Links to other sites are not opened inside MARVIS', 'info');
          break;
        case 'check-update':
          checkUpdate();
          break;
        case 'test-download':
          download(new Blob([String(d.text)], { type: 'application/json' }), String(d.name || 'mission.json'));
          break;
        case 'test-send': {
          // Exactly the site's own download, armed: the wrappers of section 5 must turn it into 'mission'.
          armSend(false);
          const url = URL.createObjectURL(new Blob([String(d.text)], { type: 'application/json' }));
          const a = document.createElement('a');
          a.href = url;
          a.download = String(d.name || 'mission.json');
          document.body.append(a);
          a.click();
          a.remove();
          setTimeout(() => URL.revokeObjectURL(url), 0);
          break;
        }
        default: // unknown types are ignored
      }
    });
    // Messages wait for the page and for the answer about the local copy, and keep their order.
    wv.addEventListener('message', (e) => {
      const d = e && e.data;
      boot.then(() => onMessage(d));
    });

    // F10 = the menu button. It works before the overlay exists, and when the overlay failed.
    window.addEventListener(
      'keydown',
      safe((e) => {
        if (e.key !== 'F10' || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey || bridge !== false) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) post({ type: 'close' });
      }),
      true,
    );

    boot.then(
      safe(() => {
        fixTree(document);
        post({ type: 'hello', inject: 1, url: location.href, bridge: bridge === true });

        if (bridge === false && mount()) {
          dock.hidden = false;
          setDock(want.r, want.t);
          const kept = safe(() => JSON.parse(session.get(K_LOG)))(); // the debrief survives an update reload
          if (kept && kept.log) showLog(kept.eva, kept.log, kept.open === true, false);
        }

        const updated = session.get(K_UPDATED);
        if (updated) {
          session.del(K_UPDATED);
          if (new Date(document.lastModified).getTime() >= Date.parse(updated) - 1000) toast('Planner updated to the latest version', 'info');
        }

        checkUpdate();
        setInterval(safe(checkUpdate), 20000);
        window.addEventListener('focus', safe(checkUpdate));
        document.addEventListener(
          'visibilitychange',
          safe(() => {
            if (!document.hidden) checkUpdate();
          }),
        );
      }),
    );
  } catch (e) {
    /* never into the page */
  }
})();
