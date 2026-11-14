# Data sources

## Rock science data (Mount Sharp, Gale crater)

The rocks in the game carry chemistry measured by NASA's **Curiosity rover (Mars Science Laboratory)** on **Mount Sharp (Aeolis Mons), Gale crater**. Every composition value is copied unchanged from public NASA Planetary Data System (PDS) products. Each in-game boulder is an *analog* of one real measured target (named below), with a small random variation inside that target's published analytical uncertainty. The game does not claim to measure its own rocks.

Data file in the project: `Assets/Mars/Resources/MarsRockDatabase.json` (schema `mars-rock-db/1`).

### NASA data used

| Data product | Archive / DOI | Used for |
|---|---|---|
| MSL APXS supplement with stratigraphic context, sols 0–3076 (`ds01_2021je007171r.csv`) | NASA PDS Geosciences Node, [doi:10.17189/6q8a-kg55](https://doi.org/10.17189/6q8a-kg55) — accompanies Berger et al., *JGR Planets*, [doi:10.1029/2021JE007171](https://doi.org/10.1029/2021JE007171) | Oxide and Ni/Zn/Br compositions (with 2σ errors), sol, elevation and stratigraphic unit of Murray, Vera Rubin ridge, Glen Torridon, Stimson and silica-alteration analogs |
| MSL APXS supplement with stratigraphic context, sols 3054–3712 (`ds01_2024.csv`) | NASA PDS Geosciences Node, [doi:10.17189/1139-2w66](https://doi.org/10.17189/1139-2w66) | Same fields for the Mirador sulfate unit, Amapari bed, Mercou/Pontours (Glen Torridon) and later Stimson analogs |
| Morris R.V. et al. (2016) PNAS 113(26), 7071-7076, doi:10.1073/pnas.1607098113, Table 1 ('Postsieve' column) and Table 2 ('Bulk sample: XRD' column). Sigmas and traces are from the PDS file msl_apxs_concentrations_mno_recalib.csv, row sol 1091 'Buckskin_post_sieve_dump_twk_corrected'. | [https://pmc.ncbi.nlm.nih.gov/articles/PMC4932983/](https://pmc.ncbi.nlm.nih.gov/articles/PMC4932983/) | Buckskin drill sample, post-sieve (<150 um) dump pile |
| Meslin P.-Y. et al. (2019) 50th LPSC, abstract #3179, Table 1, row 'Aeolis Mons 001 (Egg Rock)', Ni (wt%) +/- 2-sigma, without point #9. | [https://www.hou.usra.edu/meetings/lpsc2019/pdf/3179.pdf](https://www.hou.usra.edu/meetings/lpsc2019/pdf/3179.pdf) | Egg Rock (Aeolis Mons 001), iron-nickel meteorite |
| Meslin P.-Y. et al. (2019) 50th LPSC, abstract #3179, Table 1, row 'Aeolis Mons 002 (Ames Knob)'. | [https://www.hou.usra.edu/meetings/lpsc2019/pdf/3179.pdf](https://www.hou.usra.edu/meetings/lpsc2019/pdf/3179.pdf) | Ames Knob (Aeolis Mons 002), iron-nickel meteorite |

### Rock analogs (one row per real measurement)

| Rock class | Target | Instrument | Sol | Elevation (m, MOLA) | Stratigraphic unit / site | Preparation |
|---|---|---|---|---|---|---|
| Murray formation mudstone (lower Mount Sharp) | Mojave2 DTc drilltailings | MSL Curiosity APXS | 884 | -4459.6 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Pahrump Hills member | drill tailings |
| Murray formation mudstone (lower Mount Sharp) | Telegraph Peak DT | MSL Curiosity APXS | 922 | -4453.5 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Pahrump Hills member | drill tailings |
| Murray formation mudstone (lower Mount Sharp) | Oudam tailings APXS | MSL Curiosity APXS | 1364 | -4435.6 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Hartmann's Valley member | drill tailings |
| Murray formation mudstone (lower Mount Sharp) | Marimba2 full drill tailings | MSL Curiosity APXS | 1426 | -4410.4 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Karasburg member | drill tailings |
| Murray formation mudstone (lower Mount Sharp) | Quela full drill tailings | MSL Curiosity APXS | 1466 | -4379.5 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Karasburg member | drill tailings |
| Murray formation mudstone (lower Mount Sharp) | Sebina full drill tailings | MSL Curiosity APXS | 1496 | -4360.8 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Sutton Island member | drill tailings |
| Murray formation mudstone (lower Mount Sharp) | Duluth DBA dump center | MSL Curiosity APXS | 2080 | -4192.5 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Blunts Point member | drill-bit-assembly dump (drill fines) |
| Vera Rubin ridge (hematite-bearing Murray) | Stoer tailings | MSL Curiosity APXS | 2155 | -4169.9 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Pettegrove Point member | drill tailings |
| Vera Rubin ridge (hematite-bearing Murray) | Highfield Drill Tailings | MSL Curiosity APXS | 2247 | -4146.9 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Jura member | drill tailings |
| Vera Rubin ridge (hematite-bearing Murray) | Rock Hall Drill Tailings | MSL Curiosity APXS | 2292 | -4143.8 | Gale crater, Mount Sharp (Aeolis Mons), Murray formation, Jura member | drill tailings |
| Glen Torridon clay-bearing unit (Carolyn Shoemaker fm.) | Glen Etive 1 tailings | MSL Curiosity APXS | 2524 | -4133.4 | Gale crater, Mount Sharp (Aeolis Mons), Carolyn Shoemaker formation, Knockfarril Hill member | drill tailings |
| Glen Torridon clay-bearing unit (Carolyn Shoemaker fm.) | Hutton tailings | MSL Curiosity APXS | 2686 | -4095.4 | Gale crater, Mount Sharp (Aeolis Mons), Carolyn Shoemaker formation, Glasgow member | drill tailings |
| Glen Torridon clay-bearing unit (Carolyn Shoemaker fm.) | Glasgow1 tailings | MSL Curiosity APXS | 2776 | -4107.9 | Gale crater, Mount Sharp (Aeolis Mons), Carolyn Shoemaker formation, Glasgow member | drill tailings |
| Glen Torridon clay-bearing unit (Carolyn Shoemaker fm.) | Nontron tailings | MSL Curiosity APXS | 3072 | -4072.9 | Gale crater, Mount Sharp (Aeolis Mons), Carolyn Shoemaker formation, Mercou member | drill tailings |
| Glen Torridon clay-bearing unit (Carolyn Shoemaker fm.) | Bardou tailings | MSL Curiosity APXS | 3108 | -4066.5 | Gale crater, Mount Sharp (Aeolis Mons), Carolyn Shoemaker formation, Mercou member | drill tailings |
| Glen Torridon clay-bearing unit (Carolyn Shoemaker fm.) | Pontours tailings | MSL Curiosity APXS | 3180 | -4041.2 | Gale crater, Mount Sharp (Aeolis Mons), Carolyn Shoemaker formation, Pontours member | drill tailings |
| Mirador formation sulfate-bearing unit | Maria Gordon tailings | MSL Curiosity APXS | 3246 | -4015.2 | Gale crater, Mount Sharp (Aeolis Mons), Mirador formation, Dunnideer member | drill tailings |
| Mirador formation sulfate-bearing unit | Zechstein tailings | MSL Curiosity APXS | 3303 | -3991.1 | Gale crater, Mount Sharp (Aeolis Mons), Mirador formation, Port Logan member | drill tailings |
| Mirador formation sulfate-bearing unit | Avanavero tailings | MSL Curiosity APXS | 3528 | -3910.0 | Gale crater, Mount Sharp (Aeolis Mons), Mirador formation, Contigo member | drill tailings |
| Mirador formation sulfate-bearing unit | Canaima tailings | MSL Curiosity APXS | 3626 | -3879.8 | Gale crater, Mount Sharp (Aeolis Mons), Mirador formation, Contigo member | drill tailings |
| Mirador formation sulfate-bearing unit | Catrimani DRT | MSL Curiosity APXS | 3637 | -3863.1 | Gale crater, Mount Sharp (Aeolis Mons), Mirador formation, Catrimani member | brushed rock (DRT) |
| Amapari iron-rich bed (Mirador fm.) | Amapari1 tailings | MSL Curiosity APXS | 3684 | -3859.5 | Gale crater, Mount Sharp (Aeolis Mons), Mirador formation, Amapari member | drill tailings |
| Amapari iron-rich bed (Mirador fm.) | Amapari2 tailings | MSL Curiosity APXS | 3682 | -3859.5 | Gale crater, Mount Sharp (Aeolis Mons), Mirador formation, Amapari member | drill tailings |
| Stimson formation sandstone (Siccar Point group) | Big Sky full drill tailings | MSL Curiosity APXS | 1123 | -4434.7 | Gale crater, Mount Sharp (Aeolis Mons), Stimson formation | drill tailings |
| Stimson formation sandstone (Siccar Point group) | Okoruso full drill tailings | MSL Curiosity APXS | 1337 | -4429.3 | Gale crater, Mount Sharp (Aeolis Mons), Stimson formation | drill tailings |
| Stimson formation sandstone (Siccar Point group) | Edinburgh tailings | MSL Curiosity APXS | 2728 | -4088.7 | Gale crater, Mount Sharp (Aeolis Mons) | drill tailings |
| Stimson formation sandstone (Siccar Point group) | Venlaw DRT | MSL Curiosity APXS | 3428 | -3976.2 | Gale crater, Mount Sharp (Aeolis Mons), Stimson formation | brushed rock (DRT) |
| Silica-rich alteration (Buckskin, Stimson halos) | Greenhorn full drill tailings | MSL Curiosity APXS | 1142 | -4434.5 | Gale crater, Mount Sharp (Aeolis Mons), Stimson formation | drill tailings |
| Silica-rich alteration (Buckskin, Stimson halos) | Lubango fulldrill tailings | MSL Curiosity APXS | 1325 | -4429.0 | Gale crater, Mount Sharp (Aeolis Mons), Stimson formation | drill tailings |
| Silica-rich alteration (Buckskin, Stimson halos) | Buckskin drill sample, post-sieve (<150 um) dump pile | MSL Curiosity APXS + CheMin XRD | 1091 | — | Gale crater, Marias Pass, Murray formation (high-SiO2 laminated mudstone) | drill powder sieved to <150 um and dumped after CheMin delivery (rock interior; the same sieved fraction that CheMin analyzed) |
| Iron-nickel meteorite (found on Mount Sharp) | Egg Rock (Aeolis Mons 001), iron-nickel meteorite | MSL Curiosity ChemCam LIBS | 1505 | — | Gale crater, lower Mount Sharp, Murray formation (Sutton Island member) | natural (thin dust coat; Fe peaks reach steady intensity after ~2 shots; 9-point raster, 30 shots per point) |
| Iron-nickel meteorite (found on Mount Sharp) | Ames Knob (Aeolis Mons 002), iron-nickel meteorite | MSL Curiosity ChemCam LIBS | 1577 | — | Gale crater, lower Mount Sharp, Murray formation (Sutton Island member) | natural (dust-covered surface; 3-point raster, 30 shots per point) |

### Rock class properties

Class names and stratigraphic grouping follow the units given in the PDS supplements above. Physical and spectral properties (density, porosity, hardness, VNIR reflectance bands) were **not** measured on these Mount Sharp units: where present they are proxies taken from a similar lithology, with these references. `null` in the data means unknown.

- **Murray formation mudstone (lower Mount Sharp)** — proxy densityGcm3, porosityPct, mohs, vnir from a similar lithology (earlier class `mudstone-smectite`).
- **Vera Rubin ridge (hematite-bearing Murray)** — proxy vnir from a similar lithology (earlier class `hematite-concretion`).
- **Glen Torridon clay-bearing unit (Carolyn Shoemaker fm.)** — proxy densityGcm3, porosityPct, mohs, vnir from a similar lithology (earlier class `mudstone-smectite`).
- **Mirador formation sulfate-bearing unit** — proxy densityGcm3, porosityPct, mohs, vnir from a similar lithology (earlier class `sulfate-sandstone`).
- **Amapari iron-rich bed (Mirador fm.)** — no physical/spectral values (unknown).
- **Stimson formation sandstone (Siccar Point group)** — no physical/spectral values (unknown).
- **Silica-rich alteration (Buckskin, Stimson halos)** — proxy densityGcm3, porosityPct, mohs, vnir from a similar lithology (earlier class `silica-rich`).
- **Iron-nickel meteorite (found on Mount Sharp)** — proxy densityGcm3, porosityPct, mohs, vnir from a similar lithology (earlier class `iron-meteorite`).

References for the class properties (age, density, porosity, hardness, VNIR bands):

- Anthony, J.W., Bideaux, R.A., Bladh, K.W. & Nichols, M.C. (eds.) Handbook of Mineralogy, Mineralogical Society of America. Per-mineral data sheets (Hardness, D(meas.)) at handbookofmineralogy.org/pdfs/<mineral>.pdf (forsterite, fayalite, augite, enstatite, pigeonite, albite, anorthite, sanidine, nepheline, diopside, hedenbergite, saponite, montmorillonite, tridymite, cristobalite, quartz, jarosite, kieserite, gypsum, anhydrite, bassanite, hematite, magnesite, siderite, iron, taenite, vivianite, greigite). <https://www.handbookofmineralogy.org/>
- Arizona State University news release via EurekAlert! (31 Jan 2019) 'Mars rover Curiosity makes first gravity-measuring traverse on the Red Planet' (co-author T. Gabriel: CheMin-based grain density estimate 2810 kg/m3). <https://www.eurekalert.org/news-releases/811713>
- Arvidson, R.E. et al. (2006) Nature and origin of the hematite-bearing plains of Terra Meridiani based on analyses of orbital and Mars Exploration rover data sets. J. Geophys. Res. Planets 111. <https://doi.org/10.1029/2006JE002728>
- Ashley, J.W. et al. (2011) Evidence for mechanical and chemical alteration of iron-nickel meteorites on Mars: Process insights for Meridiani Planum. J. Geophys. Res. 116, E00F20. <https://doi.org/10.1029/2010JE003672>
- Bell, J.F. III et al. (2008) Mars Exploration Rover Pancam multispectral imaging of rocks, soils, and dust at Gusev crater and Meridiani Planum. Ch. 13 in The Martian Surface (Cambridge Univ. Press); NTRS 20070017838. <https://ntrs.nasa.gov/citations/20070017838>
- Calvin, W.M. et al. (2008) Hematite spherules at Meridiani: Results from MI, Mini-TES, and Pancam. J. Geophys. Res. Planets 113. <https://doi.org/10.1029/2007JE003048>
- Chan, M.A. et al. (2004) A possible terrestrial analogue for haematite concretions on Mars. Nature 429, 731-734. <https://doi.org/10.1038/nature02600>
- Ehlmann, B.L. et al. (2009) Identification of hydrated silicate minerals on Mars using MRO-CRISM: Geologic context near Nili Fossae and implications for aqueous alteration. J. Geophys. Res. Planets 114. <https://doi.org/10.1029/2009JE003339>
- Farley, K.A. et al. (2014) In situ radiometric and exposure age dating of the martian surface. Science 343, 1247166 (Cumberland K-Ar 4.21 +/- 0.35 Ga, detrital+authigenic mixture; exposure 78 +/- 30 Ma). <https://doi.org/10.1126/science.1247166>
- Farrand, W.H. et al. (2007) Visible and near-infrared multispectral analysis of rocks at Meridiani Planum, Mars, by the Mars Exploration Rover Opportunity. J. Geophys. Res. Planets 112. <https://doi.org/10.1029/2006JE002773>
- Gaffey, M.J. (1976) Spectral reflectance characteristics of the meteorite classes. J. Geophys. Res. 81, 905-920. <https://doi.org/10.1029/JB081i005p00905>
- Gendrin, A. et al. (2005) Sulfates in Martian layered terrains: the OMEGA/Mars Express view. Science 307, 1587-1591. <https://doi.org/10.1126/science.1109087>
- Grotzinger, J.P. et al. (2014) A habitable fluvio-lacustrine environment at Yellowknife Bay, Gale crater, Mars. Science 343, 1242777. <https://doi.org/10.1126/science.1242777>
- Grotzinger, J.P. et al. (2015) Deposition, exhumation, and paleoclimate of an ancient lake deposit, Gale crater, Mars. Science 350, aac7575 (Gale formed ~3.8-3.6 Ga; Aeolis Palus sediments deposited before ~3.3-3.1 Ga, crater counts). <https://doi.org/10.1126/science.aac7575>
- Hunt, A.C. et al. (2018) Late metal-silicate separation on the IAB parent asteroid: Constraints from combined W and Pt isotopes and thermal modelling. Earth Planet. Sci. Lett. 482, 490-500 (metal-silicate separation 6.0 +/- 0.8 Ma after CAI). <https://doi.org/10.1016/j.epsl.2017.11.034>
- Hynek, B.M. & Di Achille, G. (2017) Geologic map of Meridiani Planum, Mars. USGS Scientific Investigations Map 3356. <https://doi.org/10.3133/sim3356>
- Klingelhoefer, G. et al. (2004) Jarosite and hematite at Meridiani Planum from Opportunity's Moessbauer spectrometer. Science 306, 1740-1745. <https://doi.org/10.1126/science.1104653>
- Lewis, K.W. et al. (2019) A surface gravity traverse on Mars indicates low bedrock density at Gale crater. Science 363, 535-537 (bulk density 1680 +/- 180 kg/m3). <https://doi.org/10.1126/science.aat0738>
- McLennan, S.M. et al. (2005) Provenance and diagenesis of the evaporite-bearing Burns formation, Meridiani Planum, Mars. Earth Planet. Sci. Lett. 240, 95-121. <https://doi.org/10.1016/j.epsl.2005.09.041>
- McLennan, S.M. et al. (2014) Elemental geochemistry of sedimentary rocks at Yellowknife Bay, Gale crater, Mars. Science 343, 1244734. <https://doi.org/10.1126/science.1244734>
- Milliken, R.E. et al. (2008) Opaline silica in young deposits on Mars. Geology 36, 847-850. <https://doi.org/10.1130/G24967A.1>
- Mittlefehldt, D.W. et al. (2021) Geology and geochemistry of Noachian bedrock and alteration events, Meridiani Planum, Mars: MER Opportunity observations. J. Geophys. Res. Planets 126, e2021JE006915 (Sec. 1, 3: Burns formation = uppermost etched-unit section, Late Noachian/Early Hesperian per Hynek & Di Achille 2017; Endeavour formed in Noachian materials; CRISM Fe-Mg smectite in Marathon Valley). <https://doi.org/10.1029/2021JE006915>
- Morris, R.V. et al. (1985) Spectral and other physicochemical properties of submicron powders of hematite, maghemite, magnetite, goethite, and lepidocrocite. J. Geophys. Res. 90, 3126-3144. <https://doi.org/10.1029/JB090iB04p03126>
- Morris, R.V. et al. (2016) Silicic volcanism on Mars evidenced by tridymite in high-SiO2 sedimentary rock at Gale crater. PNAS 113, 7071-7076. <https://doi.org/10.1073/pnas.1607098113>
- PDS Geosciences Node (2026 update) CRISM Summary Parameter Calculation Reference (continuum anchors for BD530_2, BD860_2, BD1900_2, BD2290, BD2500_2, etc.). <https://pds-geosciences.wustl.edu/missions/mro/crism_summary_parameter_reference.pdf>
- Rice, M.S. et al. (2010) Silica-rich deposits and hydrated minerals at Gusev Crater, Mars: Vis-NIR spectral characterization and regional mapping. Icarus 205, 375-395. <https://doi.org/10.1016/j.icarus.2009.03.035>
- Schroeder, C. et al. (2008) Meteorites on Mars observed with the Mars Exploration Rovers. J. Geophys. Res. Planets 113 (Heat Shield Rock = IAB iron, officially 'Meridiani Planum'). <https://doi.org/10.1029/2007JE002990>
- Squyres, S.W. et al. (2004) In situ evidence for an ancient aqueous environment at Meridiani Planum, Mars. Science 306, 1709-1714. <https://doi.org/10.1126/science.1104559>
- Squyres, S.W. et al. (2008) Detection of silica-rich deposits on Mars. Science 320, 1063-1067. <https://doi.org/10.1126/science.1155429>
- Tanaka, K.L. et al. (2014) Geologic map of Mars. USGS Scientific Investigations Map 3292, pamphlet Table 1: Martian epoch lower-boundary ages from Michael (2013), Hartmann and Neukum systems. Neukum-system starts used here: Late Noachian 3.83, Early Hesperian 3.71, Late Hesperian 3.61, Early Amazonian 3.37 Ga. <https://pubs.usgs.gov/sim/3292/pdf/sim3292_pamphlet.pdf>
- Vaniman, D.T. et al. (2014) Mineralogy of a mudstone at Yellowknife Bay, Gale crater, Mars. Science 343, 1243480. <https://doi.org/10.1126/science.1243480>
- Viviano-Beck, C.E. et al. (2015) MRO CRISM Type Spectra Library (MICA), PDS data set MRO-M-CRISM-4-TYPESPEC-V1.0, volume MROCR_8001; files data/crism_typespec_<name>.tab/.lbl. Band depths, centers and I/F values in this file were computed from these PDS tables by this research step (local linear continuum, ratioed I/F corrected; I/F = 'numerator corrected' column at 0.749 um). <https://pds-geosciences.wustl.edu/mro/mro-m-crism-4-typespec-v1/mrocr_8001/data/>
- Wellington, D.F. et al. (2017) Visible to near-infrared MSL/Mastcam multispectral imaging: Initial results from select high-interest science targets within Gale Crater, Mars. American Mineralogist 102, 1202-1217. <https://doi.org/10.2138/am-2017-5760CCBY>

### What is not real measured data

- The per-rock variation (random, seeded, within each target's published 1σ uncertainty).
- Which class each in-game rock gets: chosen from the rock's real MOLA elevation on the Mount Sharp terrain, matched to the elevation span of that class's measured samples (Mount Sharp's layers are nearly flat-lying), mixed with procedural noise and the `abundance` game weight; the analog is the class sample measured closest in elevation.
- The VNIR reflectance curves: a schematic model built from published band positions and depths, anchored to the albedo.
- Class unit symbols (`Mm`, `Mvr`, `Cs`, …) and the rock field ids (`MR-0421`).
- Rock mass: estimated from the in-game mesh volume and the class density range.

### Credit

APXS data: Curiosity APXS team (PI R. Gellert, University of Guelph; instrument funded by the Canadian Space Agency) via the NASA PDS Geosciences Node, Washington University in St. Louis. Mars Science Laboratory is managed by NASA's Jet Propulsion Laboratory. Use of NASA data does not imply NASA endorsement of this project.

The dataset was compiled with AI assistance (Claude) from the sources above; composition values were cross-checked against the original PDS tables.

## Night sky (stars, constellations, planets, moons)

The night sky is the real sky over the scene's map position (the HOMELINE pad in **Gale crater**, about 4.80°S 137.38°E planetocentric, read from `MarsGeoReference`) at the in-game date and local true solar time. Mars's rotation and season, the stars, the planets, the Earth and the Moon, Phobos and Deimos are placed from published catalogues and ephemerides, not by hand. Everything is computed in the J2000 equatorial frame and rotated into the local sky with Mars's orientation model.

**Every number in the sky is NASA data**, from the NASA archives below. The only non-NASA inputs are two declared exceptions, neither of which positions or sizes anything: the star *names* on the labels (IAU) and the constellation *stick figures and label anchors* (d3-celestial). See [Not NASA data](#not-nasa-data-declared-exceptions).

Data file in the project: `Assets/Mars/Resources/MarsSkyCatalog.txt` (stars, star names, constellation labels and lines), generated by `Tools/sky/build_sky_catalog.py`. Its header lists the sources, the inputs' checksums, the record counts and the d3-celestial licence. Orbital and rotational constants: `Assets/Mars/Scripts/Sky/MarsEphemeris.cs`.

### NASA data used

| Data product | Archive | Used for |
|---|---|---|
| **Bright Star Catalogue, 5th Revised Ed. (Preliminary Version)** (Hoffleit D. & Warren W.H. Jr. 1991, Yale University Observatory; CDS/ADC catalogue V/50), NASA HEASARC table `heasarc_bsc5p` (last modified 2022-02-03) | NASA HEASARC, [heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html](https://heasarc.gsfc.nasa.gov/W3Browse/star-catalog/bsc5p.html); file [heasarc_bsc5p.tdat.gz](https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz) | All 5080 stars to V = 6.0: J2000 position, V magnitude, B−V colour (53 stars without a B−V are drawn at 0.65, a Sun-like value). Positions and magnitudes of the 186 named stars. The star points the constellation lines are drawn between. The 14 BSC entries without a position (HR 92, 95, 182, 1057, 1841, 2472, 2496, 3515, 3671, 6309, 6515, 7189, 7539, 8296: novae, clusters and a galaxy the catalogue keeps as numbered placeholders) are skipped |
| *Keplerian Elements for Approximate Positions of the Major Planets* (E.M. Standish), Table 1 (mean ecliptic and equinox of J2000, valid 1800–2050) | NASA JPL Solar System Dynamics, [ssd.jpl.nasa.gov/planets/approx_pos.html](https://ssd.jpl.nasa.gov/planets/approx_pos.html) | Heliocentric positions of Mercury, Venus, the Earth–Moon barycentre, Mars, Jupiter, Saturn, Uranus and Neptune; the Sun's direction from Mars |
| Planetary Satellite Mean Elements: Phobos and Deimos (ephemeris MAR099, Brozović M., Jacobson R.A. & Park R.S. 2025; Laplace-plane elements, epoch 2000-01-01.5 TDB) and the Moon | NASA JPL Solar System Dynamics, [ssd.jpl.nasa.gov/sats/elem](https://ssd.jpl.nasa.gov/sats/elem/) | Orbits of Phobos and Deimos around Mars; the Moon's orbit around the Earth, so the Earth and the Moon appear as two points |
| JPL Horizons ephemerides of Phobos and Deimos (MAR099) | NASA JPL Solar System Dynamics, [ssd.jpl.nasa.gov/horizons](https://ssd.jpl.nasa.gov/horizons/) | Fit of the precession and mean-motion rates of Phobos and Deimos over 2000–2035 (the mean elements alone drift from the real moons over decades); also the offline check of the whole sky |
| Planetary Physical Parameters | NASA JPL Solar System Dynamics, [ssd.jpl.nasa.gov/planets/phys_par.html](https://ssd.jpl.nasa.gov/planets/phys_par.html) | Planets' mean radii (apparent sizes), absolute magnitudes V(1,0) and geometric albedos |
| Planetary Satellite Physical Parameters | NASA JPL Solar System Dynamics, [ssd.jpl.nasa.gov/sats/phys_par](https://ssd.jpl.nasa.gov/sats/phys_par/) | Mean radii and geometric albedos of the Moon, Phobos and Deimos, from which their brightness follows |
| Planetary constants kernel `pck00010.tpc` (the IAU WGCCRE 2009 model: Archinal B.A. et al. 2011, *Celest. Mech. Dyn. Astr.* 109, 101, [doi:10.1007/s10569-010-9320-4](https://doi.org/10.1007/s10569-010-9320-4)) | NASA NAIF (JPL), [naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00010.tpc](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00010.tpc) | Mars's pole and prime meridian (`BODY499_POLE_RA`, `BODY499_POLE_DEC`, `BODY499_PM`): the rotation of the sky, the Sun's hour angle, local true solar time and the season (Ls) |
| Leapseconds kernel `naif0012.tls` | NASA NAIF (JPL), [naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls](https://naif.jpl.nasa.gov/pub/naif/generic_kernels/lsk/naif0012.tls) | TT − UTC = 69.184 s (`DELTA_T_A` = 32.184 s plus `DELTA_AT` = 37 s since 2017-01-01) |
| Mars24 Sunclock and its algorithm (Allison M. & McEwen M. 2000, *Planet. Space Sci.* 48, 215, [doi:10.1016/S0032-0633(99)00092-6](https://doi.org/10.1016/S0032-0633(99)00092-6)) | NASA Goddard Institute for Space Studies, [giss.nasa.gov/tools/mars24](https://www.giss.nasa.gov/tools/mars24/) | **Verification only**: the computed Ls and local true solar time were compared with it |

### Not NASA data (declared exceptions)

- **Star names (labels only).** The IAU Catalog of Star Names, IAU Division C Working Group on Star Names (WGSN), text version IAU-CSN last updated 2022-04-04 ([IAU-CSN.txt](https://www.pas.rochester.edu/~emamajek/WGSN/IAU-CSN.txt); official list at [iau.org/public/themes/naming_stars](https://www.iau.org/public/themes/naming_stars/)), released by the IAU under Creative Commons Attribution. Only the name text is used: each name is matched to its BSC star by HR number (by HD number for the 5 names whose IAU designation is not an HR number), checked against the IAU's own position, and drawn at the BSC position and magnitude. 186 IAU names belong to stars of V ≤ 3.5. Of the 451 names, 113 are not BSC stars and are not used: exoplanet hosts and other stars fainter than V = 6.4, plus two pulsars (Geminga, Lich). Names are shown in the IAU spelling (e.g. Rigil Kentaurus, Toliman, Schedar). Stars with only a traditional, non-IAU name (e.g. Regor) get no label.
- **Constellation stick figures and label anchors.** d3-celestial by Olaf Frohn ([github.com/ofrohn/d3-celestial](https://github.com/ofrohn/d3-celestial), BSD-3-Clause), files `data/constellations.json` (the 88 IAU constellation names, a display rank and a label position: 89 anchors, since Serpens gets one per part) and `data/constellations.lines.json` (743 line segments; per its README, after the IAU constellation charts with "some line modifications" by O. Frohn). These are drawing conventions, not measurements. Each line end is moved onto the nearest drawn BSC star within 0.1° (all 893 points found one; the largest move is 30″), so every line ends exactly on a star point.
- **Purely visual parts (formulas, not data).** Star colour comes from the BSC's B−V through Ballesteros' formula (Ballesteros F.J. 2012, *EPL* 97, 34008, [doi:10.1209/0295-5075/97/34008](https://doi.org/10.1209/0295-5075/97/34008)) and Tanner Helland's blackbody-to-RGB fit, then desaturated halfway to white (artistic: stars look nearly white to the eye). The Milky Way is an artistic glow shaped like the galaxy (disk, bulge in Sagittarius, the Great Rift), not a photometric map. It is placed with the IAU galactic coordinate system (Blaauw A. et al. 1960, *MNRAS* 121, 123), in its ICRS form from *The Hipparcos and Tycho Catalogues* (ESA SP-1200, 1997, Vol. 1 §1.5.3). That form is a coordinate convention, not data.

### What is approximate (or artistic)

- **Star positions**: BSC J2000 positions (given to 0.1 s of RA and 1″ of Dec), with no proper motion applied. The fastest star in the file, 61 Cygni A (HR 8085, 5.23″/yr), drifts about 3′ by 2035, about one pixel at 1080p with a 60° field of view. No aberration from Mars's orbital motion (under 20″) and no atmospheric refraction (Mars's surface pressure is under 1% of Earth's).
- **Star brightness**: the BSC's single V magnitude per star, so variable stars are shown at one value (Betelgeuse 0.50; Mira 3.04, near its maximum, although it spends most of its cycle much fainter).
- **How stars look on screen**: the mapping from magnitude to size and brightness, the limiting magnitude (6.0 in a dark, clear sky, lowered smoothly through twilight) and the HDR boost of the brightest stars are artistic choices, so the stars read at the game's modest resolution. Extinction uses Beer–Lambert with the weather's dust optical depth, an estimate.
- **Planets**: Keplerian approximation. JPL's nominal errors for 1800–2050 range from 10″ (Neptune) to 600″ (Saturn) in heliocentric longitude. Positions are geometric, with no light-time correction.
- **Phobos and Deimos**: mean elements of a precessing ellipse, which JPL notes "are not intended for ephemeris computation". The rates are fitted to JPL Horizons over 2000–2035, and the residuals are stated in `MarsEphemeris.cs`. Eclipses use Mars's cylindrical shadow (no penumbra), and an eclipsed moon is dimmed to 3% (artistic).
- **Magnitudes**: m = H + 5 log10(r Δ) − 2.5 log10 q(α), with a Lambert-sphere phase law instead of each body's measured phase curve and without Saturn's rings. This is a rough estimate.
- **Constellations and labels**: see the declared exceptions above. Labels that would overlap a brighter one are not drawn, so α Cen B (Toliman, 0.001° from Rigil Kentaurus) is labelled only when the two separate on screen.
- **Time**: TT − UTC is fixed at the `naif0012.tls` value; a leap second after 2017 would shift the sky by 1 s.
- **Artistic sun mode** (Real Sky off on `DayNightCycle`): the sun follows the artistic path and the real star field turns with it, with the Sun at its true right ascension among the stars. This is not the real sky for the site.

### Credit

Bright Star Catalogue: Hoffleit D. & Warren W.H. Jr. (1991), *The Bright Star Catalogue, 5th Revised Ed. (Preliminary Version)*, Yale University Observatory. This project uses data obtained from the High Energy Astrophysics Science Archive Research Center (HEASARC), provided by NASA's Goddard Space Flight Center. Planet, satellite and orientation data: NASA Jet Propulsion Laboratory, Solar System Dynamics group (Horizons, approximate planetary elements, satellite mean elements, physical parameters) and NASA's Navigation and Ancillary Information Facility (NAIF). Mars24 Sunclock: NASA Goddard Institute for Space Studies.

Star names: IAU Working Group on Star Names (WGSN), IAU Catalog of Star Names, [iau.org/public/themes/naming_stars](https://www.iau.org/public/themes/naming_stars/), Creative Commons Attribution.

d3-celestial: Copyright (c) 2015, Olaf Frohn. All rights reserved. Used under the BSD 3-Clause licence:

> Redistribution and use in source and binary forms, with or without modification, are permitted provided that the following conditions are met:
>
> 1. Redistributions of source code must retain the above copyright notice, this list of conditions and the following disclaimer.
>
> 2. Redistributions in binary form must reproduce the above copyright notice, this list of conditions and the following disclaimer in the documentation and/or other materials provided with the distribution.
>
> 3. Neither the name of the copyright holder nor the names of its contributors may be used to endorse or promote products derived from this software without specific prior written permission.
>
> THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

## Title / pause screen (MARTIS)

The rotating Mars globe and the star field behind the menu are NASA products. Files: `Assets/Mars/UI/Resources/Title/` (`mars_color.jpg`, `mars_normal.png`, `stars_strip.jpg`), built by the scripts in `Tools/title/`.

| Data product | Archive | Used for |
|---|---|---|
| Viking Orbiter MDIM 2.1 colorized global mosaic (layer `Mars_Viking_MDIM21_ClrMosaic_global_232m`, zoom level 4) | NASA Mars Trek (JPL), [trek.nasa.gov](https://trek.nasa.gov/tiles/Mars/EQ/Mars_Viking_MDIM21_ClrMosaic_global_232m/1.0.0/WMTSCapabilities.xml) | Colour of the title planet (8192×4096, stitched tiles, no grading) |
| MGS MOLA MEGDR 16 px/deg topography, `megt90n000eb.img` (MGS-M-MOLA-5-MEGDR-L3-V1.0) | NASA PDS Geosciences Node, [pds-geosciences.wustl.edu](https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/meg016/) | Relief shading of the title planet (normal map, vertical exaggeration ×8) |
| Deep Star Maps 2020, `starmap_2020_8k_gal.exr` (SVS 4851) | NASA Goddard Scientific Visualization Studio, [svs.gsfc.nasa.gov/4851](https://svs.gsfc.nasa.gov/4851/) | Star field and Milky Way behind the menu (galactic latitude ±45°, one global exposure) |

### What is artistic

The planet's lighting, atmosphere glow, tilt and spin speed, the star field's exposure, drift and twinkle are visual choices, not a depiction of a real date or viewpoint.

### Credit

Mosaic: NASA/JPL-Caltech/USGS. Topography: NASA/GSFC/MOLA Science Team; Smith D.E. et al., *Mars Global Surveyor Laser Altimeter Mission Experiment Gridded Data Record*, NASA PDS, MGS-M-MOLA-5-MEGDR-L3-V1.0, 2003. Star field: NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC. (The SVS product is rendered from ESA catalogues, Hipparcos-2, Tycho-2 and Gaia DR2, and its credit line includes them.)

Logo and menu typeface: Open Sauce Sans (SIL Open Font License 1.1, `Assets/Mars/UI/Resources/Title/Fonts/OFL.txt`).
