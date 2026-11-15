# HOMELINE dentro MARTIS (.exe): piano e stato

Aggiornato domenica 15/11 alle 02:30. Consegna: oggi entro le 20:30 (limite 21:00). Dalle 15:00 non si aggiunge più nulla.

## In breve

Un solo `.exe` Windows con un flusso a fasi:

1. **Titolo** MARTIS.
2. **Pianificazione della missione**, in una schermata a parte: si sceglie uno dei 5 piani calcolati dal motore del planner, si generano i waypoint, si vede la tabella e la mappa del percorso.
3. **Simulazione 3D** dell'attività extraveicolare: replay del piano su binari oppure cammino libero, con ossigeno e margine del planner sul casco.
4. **Pausa:** si può riaprire la pianificazione o riavviare dal titolo.

Si lavora solo nella repo `lucabresciani/Nasa-Space-App`, branch `homeline-integration`. La repo del planner si legge soltanto.

## Stato dei livelli

| Livello | Contenuto | Stato |
|---|---|---|
| 1. Pianificazione + EVA sul piano | Schermata di pianificazione, generazione dei waypoint, percorso e fari sul terreno, replay e cammino libero, pannello del piano | Fatto |
| 2. Casco e mappa | Casa = pad, O₂ e tempo di missione del planner sul casco, percorso sulla mappa `G` e sulla bussola, mappa nella schermata di pianificazione, sole sincronizzato all'orologio EVA | Fatto |
| 3. O₂ del planner in cammino libero | Consumo con la formula del planner (pendenza, massa, lavoro alle stazioni), velocità governata, margine dal vivo sul piano ufficiale | Fatto |
| Extra | Termine di dose nel margine dal vivo | Non fatto |

Verifica: l'exe si controlla da solo con `-homelineSelfTest`. L'ultima build passa 44 controlli su 44, senza eccezioni nel log. I test di logica sono 313 su 313.

## Cosa manca

| Cosa | Chi | Quando |
|---|---|---|
| Prova a mano: titolo → pianificazione → i due avvii; pausa e MISSION PLAN; un piano alternativo; riavvio; mouse, tasti, gamepad | Utente | Al risveglio |
| Clip video | Utente | 13:00–14:00 |
| Correzioni dalla prova a mano | Sessione Claude | Fino alle 15:00 |
| Build finale, autoverifica, zip | Sessione Claude | 17:30 |
| Consegna | Utente | Entro le 20:30 |
| Unione in `main`: la decide l'utente. Il commit `db2aa6d` tocca due file dell'HUD in modo additivo; l'impostazione degli shader del cielo va salvata da chi cura il cielo | Utente | Dopo la consegna |

## Scelte fatte

| Tema | Scelta | Motivo |
|---|---|---|
| Schermata di pianificazione | Pannello del menu MARTIS, non il planner web | Via più sicura; il planner web dentro l'exe è stato tolto dalla consegna |
| "Generazione dei waypoint" | Si caricano percorso e timeline già calcolati dal motore; i waypoint principali sono pad e stazioni, i punti di navigazione sono le svolte del tracciato (tolleranza 30 m) | Nel planner non esiste un oggetto "waypoint"; il motore non gira su Windows e i suoi dati (2–3 GB) non sono in git |
| Testo a schermo | Dice sempre "precomputed; no new plan computed" e che i punti di navigazione sono "derived by the simulator, not planner output" | Onestà verso l'autore del planner e verso i giudici |
| Ossigeno in replay | Timeline del planner | È il dato del motore |
| Ossigeno in cammino libero | Formula del planner sul terreno percorso | Camminando il percorso previsto si arriva a 126,17 L contro i 124,87 L del planner (meno dell'1 %) |
| Meteo | Resta un dato del simulatore, etichettato SIM | Nel planner il meteo non entra né nell'ossigeno né nel margine |
| Margine dal vivo | Solo sul piano ufficiale; O₂, luce e durata dell'EVA; dose non valutata | I campi "tempo e O₂ per tornare" esistono solo per il pad ufficiale |
| File dell'HUD | Due agganci additivi in un commit separato (`db2aa6d`) | Si può annullare o riapplicare da solo |

## Aggancio per il backend del planner

Quando il servizio del planner produrrà piani nuovi, basta mettere il risultato in `HomelineData/results/<hash>/` con `run_record.json`, `route_*.geojson` e `timeline_*.json`: il piano compare nella lista come "Computed live". Il lettore è provato solo con una cartella sintetica.

## Differenze note rispetto al planner

Sono elencate nella guida ([USER_GUIDE.md](USER_GUIDE.md), sezione "Known differences from the planner"), che la build copia accanto all'exe come `README.md`.

## Come si rifà la build

Comandi, tempi e note in [HANDOFF.md](HANDOFF.md), sezione "Build and check".
