# Science review: IST-2 uphill check and O₂ margin units (WS2 questions 1–2)

Received from the user 2026-11-14 ~11:00 CET as the answer to WS2's questions for S. WS2 implements it in session 2.
The C notes at the end list what the config already contains and must be reconciled.

## 1. Uphill cost vs IST-2: the validation test compares the wrong quantity

**+8.7 and +17.0 are not costs of climbing.** IST-2 (Norcross et al. 2010) reports them as mean differences
between the highest and lowest *weight* conditions: 8.7 mL·kg⁻¹·min⁻¹ at 20 % grade and 17.0 at 30 % grade.
They measure what adding weight does at a fixed grade. Our check compared them with level→20 % and
level→30 % increments, which is a different question. The model's +23.8/+34.9 (Mars g, 0.98 m/s) may well be
right and must not be retuned against these numbers.

What IST-2 actually tested:

| Field | Value from the report |
|---|---|
| Gravity | Lunar range, not Mars: suited weight series 0.12, 0.17, 0.22, 0.27, 0.32 g. Mars (3/8 g) not tested. |
| Weight difference (not `delta_mass_kg`) | Mean TGAW 53, 75, 97, 119, 141 lb → 141 − 53 = 88 lb ≈ 391 N extra **weight**. Encode as a gravity change of 0.20 g on the full system mass, not as extra mass. |
| System | 121 kg (265 lb) POGO configuration, subject mean 80.7 kg |
| Speed | No single value: 0.56–0.97 m/s, chosen per subject (lowest ambulation speed from each subject's PTS) |
| Normalization | mL O₂ per kg of **subject body mass** per minute, not per (subject + suit) mass |

Rough check: adding 391 N at about 0.7 m/s up a 20 % grade, at 25 % muscle efficiency and 20.1 J per mL O₂,
gives about 8 mL/kg/min, close to the reported 8.7. The same physics gives about 12 at 30 % against 17.0,
so steep grades cost more than the simple vertical-work model predicts (a finding worth reporting, not
hiding).

**Fix for the validation test:**
- Run the model twice at the same grade (20 %, then 30 %): once at 0.12 g and once at 0.32 g, with the
  121 kg + 80.7 kg system.
- Normalize per kg of subject body mass.
- Sweep the speed over 0.56–0.97 m/s. Pass if 8.7 (20 %) and 17.0 (30 %) fall inside the resulting band.
  A single speed is not enough.
- Validate the level→grade increment separately, against data that measured it. If no such reference is in
  hand, report it as "not validated".

## 2. O₂ units and the margin formula

NASA's usual units:
- **Metabolic rate:** W, BTU/hr or kcal/hr. BTU/hr is the operational standard: ISS/EMU at 1000 BTU/hr
  average, with 1200 BTU/hr expected for future Moon/Mars mission sizing.
- **O₂ uptake:** mL/kg/min for physiology, L/min for flow.
- **Consumable budgets:** sometimes kept as energy. The ISS budget is 8000 BTU Metox, minus a 600 BTU
  emergency reserve and 500 BTU prebreathe.
- **Operational reserves:** given in minutes. The Shuttle EVA timeline kept 30 min reserve; the secondary
  O₂ pack gives at least 30 min.

Conversion (ICES-2026-127): MetRate (kcal/min) = 4.039 × VO₂ (L/min) + 1.157 × VCO₂ (L/min). At RER 0.85
that is about 5.0 kcal per litre of O₂, so:
- effort cap 1.35 L/min ≈ 1,600 BTU/hr
- 1,000 BTU/hr ≈ 0.84 L/min
- resting ≈ 0.3 L/min ≈ 360 BTU/hr

Decisions for WS2:
1. **Units:** keep the budget in **litres of O₂**; convert to minutes only for display.
2. **Converting at the effort cap (1.35 L/min): confirmed.** It is the conservative choice. Label it
   "minutes at maximum effort" (1,600 BTU/hr is well above NASA's 1,000–1,200 BTU/hr planning rates).
   Optionally show the time at 1,200 BTU/hr next to it.
3. **Station stops: replace the resting rate.** The crew works at a station (geology, sampling). Use a task
   rate of about **1,000 BTU/hr ≈ 0.84 L/min** per station minute (or the 1,200 BTU/hr planning figure for
   headroom).
4. **Reserve:** a fixed **30 min at the effort cap** (EMU precedent), about 40.5 L.

Margin formula (all terms in litres):

```
margin_min = (O2_left − O2_return_route − O2_station_tasks − O2_reserve_30min) / 1.35
```

This shrinks the O₂ margins further. S should look at the new numbers before G1.

Sources:
- Norcross et al. 2010, IST-2 inclined ambulation (NTRS):
  https://ntrs.nasa.gov/api/citations/20110003409/downloads/Norcross%20et%20al%202010%2C%20Metabolic%20costs%20%26%20biomech%20of%20inclined%20ambulation%20%26%20exploration%20tasks%20in%20a%20planet%20suit.pdf
- ICES-2026-127 Mars suit mass presentation:
  https://ntrs.nasa.gov/api/citations/20260005410/downloads/Mars_Mass_ICES2026_Presentation_Final.pdf
- ISS RDC 2024 metabolic rate prediction:
  https://ntrs.nasa.gov/api/citations/20240009328/downloads/ISS%20RDC%202024_Met%20Rate%20Prediction_final_2.pdf
- NASA EVA systems overview (EMU reserve/SOP):
  https://ntrs.nasa.gov/api/citations/20140009556/downloads/20140009556.pdf

## C notes for WS2 (reconcile, then report; don't silently retune)

- `config/variants.yaml` `ist2.delta_mass_kg: 60` also feeds the **level-slope term**
  `alpha = ist2.level_increment / (ist2.delta_mass_kg * anchor.speed)`. If IST-2's weight span is a gravity
  change (0.12 → 0.32 g on 201.7 kg), the level increment of 1.9 mL/kg/min has the same encoding issue.
  Work out what alpha becomes when encoded consistently. Report the before/after numbers for S, and do not
  change the model until S has seen them.
- `config/crew.yaml` already has `reserve_min: 30` and `o2_reserve_frac: 0.2` (the "r" in the route margin,
  assumed). The new fixed 30-min reserve at the effort cap must not be double-counted with the 20 % fraction.
  Implement the formula above, keep `o2_reserve_frac` only if SPEC m(t) still needs it elsewhere, and state
  which one you used.
- New constants go into config with their source cited above (not `assumed: true`):
  - the station task rate 0.84 L/min (1000 BTU/hr);
  - RER 0.85 and the conversion coefficients;
  - reserve = 30 min × effort cap.
