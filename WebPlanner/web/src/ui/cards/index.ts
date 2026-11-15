// Selection cards (U14, package A5). The store lives in state/selection.ts; the map adapter in
// state/selectionAdapter.ts. The shell installs the sidebar wiring lazily (shell/Shell.tsx).
export { SelectionCard, PadCard, StationCard, LegCard, CellCard, EdgeCard, LandmarkCard, RouteSummaryCard, FieldReadout, fieldKey, bindingText } from './cards'
export { loadCardData, ensureFor, isReady, activeFieldLookup, lowestMarginRow, OFFICIAL_PAD, type CardData, type CellLookup, type LabelRow, type RouteData } from './data'
export { installSelectionSidebar, handleSelectionShortcut, SelectionPanel, cardData } from './sidebar'
