// App shell (DESIGN U0, §4.3; WS15 task 4, package A4). Extension API: store.ts header.
export { buildLegacyFrame, buildShellFrame, type Frame, type FrameKind } from './frame'
export { mountShell, type ShellHandle } from './Shell'
export { HELP_ROWS, installShortcuts, isTypingTarget, runShortcut, shortcutFor, type ShortcutAction } from './keys'
export {
  applyRoute,
  breakpointFor,
  closeSidebar,
  isMapMode,
  MODE_VIEWS,
  modeHash,
  modeOf,
  openSidebar,
  registerRailSection,
  setDockContent,
  setSidebarContent,
  shell,
  type RailSection,
} from './store'
