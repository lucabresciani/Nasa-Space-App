// Ellipse geometry for drawing the 95% error ellipses (presentation only: the ellipse parameters
// come from the Monte Carlo files). Convention (contract, WS9 pipeline): a_m / b_m are the
// semi-axes, theta_deg is the major-axis azimuth clockwise from grid north. Local frame: east,
// north in metres around a centre; lon/lat via an equirectangular metric on the Mars sphere.
import type { Ellipse, LonLat } from './types'

export interface Metric {
  mPerDegLon: number
  mPerDegLat: number
}

const RAD = Math.PI / 180

/** Metres per degree at latitude lat on a sphere of radius R (config/site.yaml crs.mars_radius_m). */
export function sphereMetric(lat: number, R: number): Metric {
  const mPerDegLat = R * RAD
  return { mPerDegLon: mPerDegLat * Math.cos(lat * RAD), mPerDegLat }
}

/** Unit vector (east, north) of the major axis. */
export function majorAxis(thetaDeg: number): [number, number] {
  return [Math.sin(thetaDeg * RAD), Math.cos(thetaDeg * RAD)]
}

/** Closed ring of n + 1 points (east, north) starting at the major-axis tip, clockwise. */
export function ellipseRingENU(a: number, b: number, thetaDeg: number, n: number): [number, number][] {
  const [ue, un] = majorAxis(thetaDeg)
  const ve = un // minor axis = major rotated 90 deg clockwise
  const vn = -ue
  const out: [number, number][] = []
  for (let i = 0; i <= n; i++) {
    const t = (2 * Math.PI * (i % n)) / n
    const ca = a * Math.cos(t)
    const sb = b * Math.sin(t)
    out.push([ca * ue + sb * ve, ca * un + sb * vn])
  }
  return out
}

/** (u/a)^2 + (v/b)^2 for the offset (de, dn): <= 1 inside. Degenerate axes handled. */
export function ellipseValue(de: number, dn: number, ell: Ellipse): number {
  const [ue, un] = majorAxis(ell.theta_deg)
  const u = de * ue + dn * un
  const v = de * un - dn * ue
  const term = (x: number, s: number) => (s > 0 ? (x / s) ** 2 : Math.abs(x) <= 1e-9 ? 0 : Infinity)
  return term(u, ell.a_m) + term(v, ell.b_m)
}

export function insideEllipse(de: number, dn: number, ell: Ellipse): boolean {
  return ellipseValue(de, dn, ell) <= 1 + 1e-9
}

/** Half-extents of the axis-aligned bounding box (metres east, north). */
export function ellipseBBox(ell: Ellipse): { halfE: number; halfN: number } {
  const s = Math.sin(ell.theta_deg * RAD)
  const c = Math.cos(ell.theta_deg * RAD)
  const a2 = ell.a_m * ell.a_m
  const b2 = ell.b_m * ell.b_m
  return { halfE: Math.sqrt(a2 * s * s + b2 * c * c), halfN: Math.sqrt(a2 * c * c + b2 * s * s) }
}

export function toENU(p: LonLat, centre: LonLat, m: Metric): [number, number] {
  return [(p[0] - centre[0]) * m.mPerDegLon, (p[1] - centre[1]) * m.mPerDegLat]
}

export function fromENU(e: number, n: number, centre: LonLat, m: Metric): LonLat {
  return [centre[0] + e / m.mPerDegLon, centre[1] + n / m.mPerDegLat]
}

/** Closed lon/lat ring around centre. */
export function ellipseRingLonLat(centre: LonLat, ell: Ellipse, m: Metric, n: number): LonLat[] {
  return ellipseRingENU(ell.a_m, ell.b_m, ell.theta_deg, n).map(([e, nn]) => fromENU(e, nn, centre, m))
}
