// /about — data, licences, SI-use statement (SPEC F17, §10.2–10.3). Text only.
import { DATA_MODE } from '../env'
import { Page, preactView } from './page'
import { RealModelledSimulated } from './scorecard'

const SOURCES: [string, string, string][] = [
  ['MSL Gale Merged DEM 1 m v3', 'MRO, MEX (ESA), MGS', 'USGS Astrogeology'],
  ['HiRISE DTMs and orthoimage', 'MRO HiRISE', 'USGS STAC / PDS'],
  ['Gale HiRISE LRGB colour mosaic (map basemap; NASA/JPL/University of Arizona)', 'MRO HiRISE', 'USGS Astrogeology (ASC S3)'],
  ['CTX DTMs; MOLA–HRSC blended DEM', 'MRO CTX; MGS, MEX (ESA)', 'USGS Astrogeology'],
  ['CRISM MTRDR', 'MRO CRISM', 'PDS ODE'],
  ['THEMIS thermal inertia', 'Mars Odyssey', 'USGS Astrogeology'],
  ['MSL waypoints (MMGIS)', 'MSL', 'NASA/JPL MMGIS'],
  ['Navcam frames and camera models', 'MSL', 'NASA raw-image API'],
  ['RAD dose rates', 'MSL RAD', 'NASA CDAWeb'],
  ['REMS archive', 'MSL REMS', 'PDS Atmospheres'],
  ['DONKI space-weather records', 'CCMC', 'api.nasa.gov'],
  ['Ephemeris; Mars24 algorithm', 'JPL; GISS', 'JPL Horizons; Allison & McEwen 2000'],
]

// The sentence after the scorecard link (D86): unchanged in static builds; in live builds it says what
// does go to a server, in the words of the privacy note (src/live/privacy.tsx) that follows on the page.
export const STATIC_SENTENCE = 'Nothing is fetched live.'
export const LIVE_SENTENCE =
  'In this live build the map data and the scorecard are still precomputed; the live tools send your planning requests to the live server, which the app also checks every few seconds (see Privacy below).'

function About() {
  if (import.meta.env.VITE_LIVE === '1') void import('../live').then((m) => m.mountPrivacy(document))
  return (
    <Page title="About HOMELINE">
      <p class="lead">Mars isn't flat: HOMELINE draws where a suited crew can really go and still get home, and checks it against Curiosity's own photos.</p>
      <p>
        A static site: every number was computed offline during NASA Space Apps 2026 from public data and is listed with its file, script
        and commit on the <a href="#/scorecard">scorecard</a>. {import.meta.env.VITE_LIVE === '1' ? LIVE_SENTENCE : STATIC_SENTENCE}
        {DATA_MODE === 'dummy' && <b> This build shows dummy data.</b>}
      </p>
      <h2>Data</h2>
      <table class="mini">
        <thead>
          <tr>
            <th>Product</th>
            <th>Mission</th>
            <th>From</th>
          </tr>
        </thead>
        <tbody>
          {SOURCES.map(([p, m, a]) => (
            <tr>
              <td>{p}</td>
              <td>{m}</td>
              <td>{a}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h2>Real, modelled, simulated</h2>
      <RealModelledSimulated />
      <h2>Licences</h2>
      <p>Code: Apache-2.0. Per-source data licences and credits: to be completed by the team before submission.</p>
      <h2>Super Intelligence (SI) use statement</h2>
      <p class="muted">To be written by the team before submission (SPEC §10.3).</p>
    </Page>
  )
}

export const view = preactView(() => <About />)
