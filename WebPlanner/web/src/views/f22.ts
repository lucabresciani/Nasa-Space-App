// F22 skyline fix as a validation finding (C 11:58): a station's skyline result would become a
// position fix only if error_m <= the gate tolerance (config/nav.yaml skyline_fix_gate, tolerance
// from skyline_fix.refine_grid_m). The page only compares the stored error with that tolerance.

export interface F22Frame {
  station: string
  image_id: string | null
}

export interface F22Row extends F22Frame {
  error_m: number | null
  /** true = within tolerance, false = outside, null = no result for this frame. */
  pass: boolean | null
}

export function f22Rows(frames: F22Frame[], locs: Record<string, { error_m: number | null } | null | undefined>, toleranceM: number): F22Row[] {
  return frames.map((f) => {
    const l = f.image_id ? locs[f.image_id] : null
    const e = l?.error_m ?? null
    return { ...f, error_m: e, pass: e === null ? null : e <= toleranceM }
  })
}

export function f22Verdict(rows: F22Row[]): { kind: 'none-pass' | 'some-pass' | 'unknown'; evaluated: number; passed: string[] } {
  const ev = rows.filter((r) => r.pass !== null)
  const passed = ev.filter((r) => r.pass).map((r) => r.station)
  return { kind: ev.length === 0 ? 'unknown' : passed.length ? 'some-pass' : 'none-pass', evaluated: ev.length, passed }
}
