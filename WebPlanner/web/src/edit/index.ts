// Plan-edit store (WS18, U15; DESIGN §5.2). Public API for H2 (gestures) and H3 (ghost, delta strip,
// buttons). Nothing here is mounted by a view yet.
export { createPlanEditStore, STORAGE_KEY, UNDO_MAX, type DeltaRow, type Draft, type Ghost, type PadDragSample, type PlanEditOptions, type PlanEditStore, type PlanStep, type ResultRef } from './store'
export { allOptions, buildCatalog, isCustomPad, isPrecomputed, loadEditCatalog, nearestPad, offeredOptions, planAvailability, type Availability, type EditCatalog, type EditOption, type EditPlan, type LonLat } from './options'
export { canonicalJson, CONTRACT_VERSION, defaultInputs, hashCanonical, inputsKey, resultHash, type EngineIdentity, type PlanInputs } from './canonical'
export { applyToMission, editButtons, followMission, handleEditKey, handleEditShortcut, installPlanEdit, missionApply, planFromMission, registerEditActions, type EditButton } from './bind'
export { connectLive, identityOf, loadLivePort, type LiveEditPort } from './live'
// Drag the rover, static mode (H2, WS18 task 2). The map binding (roverMap.ts) is loaded lazily by ConsoleMap.
export { cyclePad, dragRows, PAD_VALIDITY, snapTarget, spotValues, type DragFields, type DragGrid, type SpotValues, type Validity } from './drag'
export { createRoverDrag, type RoverDrag, type RoverDragState } from './rover'
export { afterimageOpacity, crossfadeFrom, crossfadeMs } from './crossfade'
