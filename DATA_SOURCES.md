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
- Where each rock class appears on the map (procedural placement weighted by `abundance`, a game parameter).
- The VNIR reflectance curves: a schematic model built from published band positions and depths, anchored to the albedo.
- Class unit symbols (`Mm`, `Mvr`, `Cs`, …) and the rock field ids (`MR-0421`).
- Rock mass: estimated from the in-game mesh volume and the class density range.

### Credit

APXS data: Curiosity APXS team (PI R. Gellert, University of Guelph; instrument funded by the Canadian Space Agency) via the NASA PDS Geosciences Node, Washington University in St. Louis. Mars Science Laboratory is managed by NASA's Jet Propulsion Laboratory. Use of NASA data does not imply NASA endorsement of this project.

The dataset was compiled with AI assistance (Claude) from the sources above; composition values were cross-checked against the original PDS tables.
