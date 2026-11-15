import { describe, expect, it } from 'vitest'
import { gradeModel, scenarioParams } from './physio'

// Known answers from the Python engine (pipeline/engine/physio.py governor / vo2 / o2_litres at the
// exact grade, config/*.yaml as committed), computed 2026-11-14:
//   pace = 1 / v*  (s/m),  o2 = VO2(v*, theta) * m_b * (1 / v* / 60) / 1000  (L/m); inf = impassable.
// Rows: [grade deg, pace s/m, O2 L/m].
const ENGINE: Record<string, [number, number, number][]> = {
  nom_104: [
    [-30, Infinity, Infinity],
    [-15, 1.6666666666666667, 0.024089971512890176],
    [-5, 1.0, 0.015584701851148883],
    [0, 1.0963511096344996, 0.02466789996677624],
    [5, 1.9586119245513312, 0.04406876830240495],
    [10, 2.81431041401933, 0.06332198431543493],
    [15, 3.6569341958487716, 0.08228101940659735],
    [19.9, 4.4638394597422755, 0.1004363878442012],
    [21, Infinity, Infinity],
  ],
  con_120: [
    [-15, 1.6666666666666667, 0.026609371585216025],
    [-5, 1.0, 0.017138884615363295],
    [0, 1.2410190090751834, 0.027922927704191625],
    [5, 2.3888337302307057, 0.053748758930190876],
    [15, 4.649587403061713, 0.10461571656888854],
    [19.9, Infinity, Infinity],
  ],
  opt_80: [
    [-15, 1.6666666666666667, 0.022521145757646747],
    [0, 1.0569423270414893, 0.023781202358433506],
    [10, 2.3029347895623555, 0.051816032765153],
    [21, 3.6283701988557664, 0.08163832947425474],
  ],
}

describe('mission cost model = engine physio (per metre)', () => {
  for (const [sid, rows] of Object.entries(ENGINE)) {
    const m = gradeModel(scenarioParams(sid))
    for (const [deg, pace, o2] of rows) {
      it(`${sid} at ${deg} deg`, () => {
        const r = m.exact((deg * Math.PI) / 180)
        if (pace === Infinity) {
          expect(r.pace).toBe(Infinity)
          expect(r.o2).toBe(Infinity)
        } else {
          expect(r.pace).toBeCloseTo(pace, 10)
          expect(r.o2).toBeCloseTo(o2, 12)
        }
      })
    }
  }

  it('lookup table matches the exact model within the engine KAT (rel err < 1e-4)', () => {
    const m = gradeModel(scenarioParams('nom_104'))
    for (const deg of [-19.37, -7.21, -0.004, 0.003, 3.33, 12.71, 19.99]) {
      const th = (deg * Math.PI) / 180
      const e = m.exact(th)
      const t = m.lookup(th)
      expect(Math.abs(t.pace - e.pace) / e.pace).toBeLessThan(1e-4)
      expect(Math.abs(t.o2 - e.o2) / e.o2).toBeLessThan(1e-4)
    }
  })

  it('minimum pace is a lower bound of every passable grade (A* heuristic stays admissible)', () => {
    const m = gradeModel(scenarioParams('nom_104'))
    for (let deg = -20; deg <= 20; deg += 0.5) expect(m.lookup((deg * Math.PI) / 180).pace).toBeGreaterThanOrEqual(m.minPace)
    expect(m.minPace).toBeCloseTo(1.0, 12) // v_safe cap 1.0 m/s on gentle downhill
  })

  it('unknown scenario id throws', () => {
    expect(() => scenarioParams('xyz_104')).toThrow()
  })
})
