// Timeline dock (DESIGN U5; WS15 task 7, package A7). The shell mounts it with installTimelineDock().
export { installTimelineDock, loadTimelineModel } from './install'
export { buildTimelineModel, dwellAt, fmtEva, nextTurnBack, rowAt, type TimelineModel } from './model'
export { DockTicker } from './ticker'
export { chartScales, CHART_H, CHART_W, Timeline } from './Timeline'
