// Report view (A10, not built yet). Placeholder exports the Report view will mount.
// D76 "Send to simulator" slot: the same slot as on the plan card (ui/cards/simslot.tsx), behind
// VITE_SIM_EXPORT (default off); it renders nothing unless the loaded result's manifest lists a file
// of kind "sim_plan". Pass `base` when the report shows a live result tree.
export { SimSlot as ReportSimSlot, type SimSlotProps as ReportSimSlotProps } from '../ui/cards/simslot'
