// Presentation-only constants (colours, line widths, legend bin step). No science values live
// here: those come from config/ (src/config.ts) or from data files. Kept in web/ because WS5 owns
// no config file; flagged in STATUS.md in case C wants them in config/.
export const THEME = {
  mapBackground: '#4a3328', // plain background: outside the basemap bounds, or no basemap tiles
  basemapOpacity: 1, // default raster-opacity of the HiRISE basemap (user slider in Layers)
  variant: { optimistic: '#f5c58f', nominal: '#ef8a4c', conservative: '#a8431f' } as Record<string, string>,
  bandFillOpacity: { optimistic: 0.22, conservative: 0.32 },
  bandLineWidth: { selected: 3, other: 1.2 },
  cause: { physiology: '#6fc3ea', slope: '#ff5a4a', data: '#d9d9d9' } as Record<string, string>,
  causeLabel: { physiology: 'physiology', slope: 'slope', data: 'no data' } as Record<string, string>,
  causeHelp: {
    physiology: 'set by walking cost and pace',
    slope: 'blocked by slope over the no-go limit',
    data: 'unknown terrain or a terrain-source boundary',
  } as Record<string, string>,
  edgeLineWidth: 3.5,
  isoBinStepMin: 10,
  isoRamp: ['#fff3b0', '#ffd27a', '#f9a65a', '#e8774a', '#c4503d', '#8f2f3a'],
  isoFillOpacity: 0.35,
  route: '#ffffff',
  walked: '#ff6ad5', // EVA debrief: the track walked in the simulator (apart from the white legs, the blue way home, the orange bands)
  partner: '#d4b3ff',
  station: '#ffd166',
  pad: '#ffffff',
  sitingOpacity: 0.6, // F8 siting heatmap (grey, white = highest score)
  hatch: { period: 6, lineWidth: 2, line: [225, 225, 225, 190], fill: [70, 70, 70, 90] } as {
    period: number
    lineWidth: number
    line: [number, number, number, number]
    fill: [number, number, number, number]
  },
  maxEdgeLabelsPerFeature: 2,
  maxEdgeLabels: 14, // whole layer: real edges come as ~2,500 small features per budget
  edgeLabelMinSepM: 250, // minimum ground distance between two edge labels
} as const
