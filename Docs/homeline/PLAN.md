# HOMELINE dentro l'app Unity (.exe): piano di integrazione

Aggiornato sabato 14/11 alle 20:20. Consegna: domenica 15/11 entro le 20:30 (limite 21:00).

## In breve

Un solo `.exe` con un flusso a fasi:

1. **Titolo** (schermata MARTIS).
2. **Pianificazione della missione:** la web app del planner, a tutto schermo.
3. **Simulazione 3D** su Marte: replay del piano oppure cammino libero, con il casco che giudica dal vivo se si riesce a tornare.
4. **Pausa:** si torna alla schermata titolo.

Il planner non resta a schermo durante la simulazione. La repo del planner non viene modificata: si lavora solo nella repo `lucabresciani/Nasa-Space-App`, sul branch `homeline-integration`.

## Decisioni prese

| Tema | Decisione |
|---|---|
| Consegna | Un `.exe` Windows, entro domenica sera |
| Viste 2D del planner | Restano la web app, servita dall'app in locale e mostrata in una finestra a tutto schermo senza barre, solo nella fase di pianificazione |
| Modalità EVA | Replay su binari e cammino libero |
| "Dal vivo" | **Giudizio dal vivo dentro Unity**: margine e ossigeno calcolati dallo stato reale del giocatore con le formule del planner. Nessun ricalcolo del percorso per la consegna |
| Ricalcolo del percorso (motore Python) | Dopo l'hackathon |
| Dove si lavora | Branch `homeline-integration`, in una cartella separata. Le repo del planner si leggono soltanto |
| Risorse | 2 persone, 2 PC |
| Casco (HUD) | Lo collega questa sessione ai dati veri, ma solo dopo che la sessione HUD ha finito la parte estetica e l'utente dà il via |

## Cosa si consegna, a livelli

Ogni livello è dimostrabile da solo: se il tempo finisce, si consegna l'ultimo livello completo.

| Livello | Cosa contiene | Probabilità (stima) |
|---|---|---|
| **1. Base** | Titolo, pianificazione, poi replay 3D del piano ufficiale con percorso e stazioni visibili sul terreno | Molto probabile |
| **2. Nucleo** | + cammino libero; casco con dati veri (tempo di rientro, margine, O₂, allarmi, direzione del rover); minimappa | ~65–70 % |
| **3. Giudizio dal vivo** | + O₂ consumato secondo il passo reale; margine dallo stato reale; scostamento dal piano; diario della missione | ~60 % |

**Fuori dalla consegna:**
- Ricalcolo del percorso (scelta delle stazioni, pad personalizzato).
- Cambio di scenario dentro Unity: il pacchetto dati copre il piano ufficiale `rank1.nom_104`.
- Effetti visivi della tempesta, mappa ingrandita, contorni homeline in 3D.
- Vista di confronto piano/percorso nella web app.

## Come funziona

```
MARTIS.exe  (Unity)
├─ Titolo / Pausa                  schermata MARTIS (sessione "e1"), sempre presente dietro
├─ Pianificazione
│    PlannerServer   http://127.0.0.1:porta/  → serve HomelineData/web + inietta bridge.js
│    BrowserProcess  Chrome/Edge/Brave a tutto schermo, profilo dedicato; chiuso dall'app
│    bridge.js       barra nella pagina: "Start EVA · replay", "Start EVA · free walk", "Back to menu"
└─ Simulazione
     dati:    HomelineData/bundle  (plan_bundle.zip + world_pack.zip, contratto bundle v1)
     logica:  Core (C# puro): percorso, timeline, fisiologia, margini, allarmi, scostamento
     scena:   replay su binari / cammino libero → dati al casco, minimappa, marcatori sul terreno
```

**Regole che il simulatore rispetta** (dal contratto del planner):
1. Tempo e ossigeno per tornare si leggono dalle griglie esportate, mai ricalcolati.
2. Le formule portate in C# devono riprodurre i casi di prova `golden.json` del planner.
3. Ogni vista porta l'etichetta "Simulated EVA · real terrain and data".
4. Tutto ciò che il planner non definisce è un'assunzione e va etichettato come tale.

### Il giudizio dal vivo

Il margine è il minimo di quattro limiti, calcolati dalla posizione e dallo stato reali:

| Limite | Formula |
|---|---|
| Ossigeno | (O₂ rimasto − O₂ per tornare da qui − O₂ dei compiti in corso − 40,5 L) ÷ 1,35 L/min |
| Luce | ora del buio − ora attuale − tempo per tornare da qui |
| Radiazione | τ(t) − tempo per tornare da qui, con τ(t) dalla serie della tempesta del 20/5/2024 |
| Durata EVA | 390 min − ora attuale − tempo per tornare da qui |

- **Verifica già fatta:** calcolato così, il margine riproduce tutte le 20 righe del piano ufficiale entro 0,26 minuti, con lo stesso limite vincolante.
- **Ossigeno nel replay:** si legge dalla timeline del piano.
- **Ossigeno nel cammino libero:** si integra dal vivo con la formula F3 del planner, senza smorzamento, con la pendenza misurata su almeno 3 m di cammino. Su 3 m coincide col planner entro 0,32 L; metro per metro sbaglierebbe di 10 L.
- **Allarmi:** le 5 regole del planner, vince la prima. Lo scostamento dal piano (ritardo, O₂ in più, distanza dal percorso) è una lettura a parte, etichettata come stima.

**Assunzioni da etichettare nel cammino libero** (il planner non le definisce):
- arrivo a una stazione entro 5 m dal suo punto di accesso;
- sosta di 30 min al ritmo dei compiti (0,8373 L/min);
- fermo fuori stazione: consumo a riposo;
- velocità massima = quella "governata" del planner (0,91 m/s in piano, 0,36 a +10°), non 1,4 m/s.

### La fase di pianificazione

- Il planner si apre a tutto schermo sopra la schermata titolo, che resta utilizzabile come ripiego.
- "Start EVA" nella pagina chiama l'app, che porta la propria finestra in primo piano e chiude il browser.
- Se nessun browser Chromium è installato, si apre il browser predefinito e si avvia dalla schermata titolo.
- Mai chiudere il browser per nome: si chiude solo il processo avviato dall'app, con il suo profilo dedicato.

## Coordinate

In doppia precisione (`PadFrame`):

```
metri locali al pad (x est, y nord)  →  lon/lat con la proiezione dichiarata nel bundle
lon/lat  →  mondo Unity con la stessa mappatura lineare di MarsGeoReference (+X est, +Z nord)
quota    →  quella del terreno Unity nel punto
```

- Pad ufficiale: lon 137.401783, lat −4.77748 → Unity X 1014,096, Z 1475,186 (verificato dai test).
- Il percorso ufficiale sta tutto dentro il terreno a 1 m (X da −666 a 1437, Z da −364 a 1475).
- Dal pad il terreno a 1 m arriva solo a 573 m verso nord: oltre, il casco mostra "coarse terrain".

## Dove sta il codice

Tutto nel branch `homeline-integration`, cartella `C:\Users\bresc\Nasa-Space-App-homeline`.

| Percorso | Contenuto |
|---|---|
| `Assets/Mars/Scripts/Homeline/Core/` | Logica pura (dati del bundle, percorso, timeline, fisiologia, margini, allarmi). Nessuna dipendenza da Unity |
| `Assets/Mars/Scripts/Homeline/Net/` | Server locale, processo browser, chiamate alle finestre di Windows. Nessuna dipendenza da Unity |
| `Assets/Mars/Scripts/Homeline/Sim/` | Componenti Unity: dati, quota del terreno, regia dell'EVA, modalità |
| `Assets/Mars/Editor/Homeline/` | Build dell'exe da menu o da riga di comando |
| `Assets/StreamingAssets/homeline/bridge.js` | Barra iniettata nella pagina del planner |
| `Tools/homeline-core/` | Test con `dotnet`, senza aprire Unity |
| `Tools/homeline-dev/` | `unity_check.py` (compila contro le librerie di Unity senza aprire l'editor), `make_meta.py` |
| `Tools/homeline-data/fetch.ps1` | Riempie `HomelineData` (fuori da git) |

**Dati del planner:** cartella `HomelineData` accanto al progetto (e accanto all'exe nella build), con web app (251 MB) e pacchetto dati (58 MB). Non entra in git. Viene dal commit `d943f39` della repo del planner; i due PC devono usare lo stesso.

## Stato al 14/11, 20:20

**Fatto e verificato:**
- Branch e cartella separata creati. Nessun commit, nessun push.
- Copia di sola lettura del planner, web app costruita, pacchetto dati ufficiale verificato (hash corrispondenti).
- Dati web e pacchetto dati coincidono byte per byte: pianificazione e simulazione mostrano lo stesso piano.
- Lettura del bundle, griglie e coordinate: 59 controlli su 59 passano.
- Controllo di compilazione fuori editor: 0 errori.
- Script di build dell'exe e script dei dati scritti; `HomelineData` popolata.

**In corso** (tre filoni in parallelo, ciascuno con un revisore indipendente):
- piano: percorso, timeline, punti, orologio EVA, scostamento, via di casa;
- fisiologia e margini: i 68 casi `golden.json`, tempesta, sole, allarmi;
- server locale, browser, finestre, `bridge.js`.

**Da fare:**
1. Regia dell'EVA in Unity: caricamento dati, replay, cammino libero, stato dal vivo.
2. Flusso titolo → pianificazione → EVA, agganciato alla schermata MARTIS.
3. Marcatori sul terreno e minimappa.
4. Collegamento al casco (quando l'utente dà il via).
5. Prima build dell'exe, poi collaudo su PC pulito.

## Coordinamento

**Altre sessioni sullo stesso progetto** (lavorano nella cartella principale, su `main`):

| Sessione | Cosa fa | Cosa serve da lei |
|---|---|---|
| `f7` cielo | Sole e cielo reali (`DayNightCycle`, `Sky/`) | Un modo per impostare l'istante UTC dell'EVA |
| `c1` casco | HUD (`Scripts/HUD/`, `UI/`) | Nulla per ora; concordato che O₂, margine e HOME verranno dai nostri dati |
| `e1` titolo | Schermata MARTIS titolo/pausa (`Scripts/Menu/`) | Un aggancio per inserire la pianificazione tra START SIMULATION e la simulazione (richiesto) |

**Per unire il loro lavoro al branch:**
- Devono prima fare commit su `main`, in quest'ordine e ciascuno completo: cielo, poi casco, poi titolo. Un commit parziale lascia `main` che non compila.
- Poi si fa `git merge main` nel branch. Mai copiare file a mano: i file `.meta` devono arrivare via git.
- Il branch non crea nulla dentro `Scripts/HUD`, `Scripts/Sky`, `Scripts/Menu`, `Mars/UI`.

**Regole git:**
- Commit solo nella cartella del branch, con percorsi espliciti. Mai `git add -A`, mai stash, mai force-push.
- File `.cs` e `.meta` nello stesso commit.
- Commit e push solo con l'OK dell'utente.

**Secondo PC:**
1. Unity 6000.6.7f1, Git con LFS, .NET SDK 10, Node 24, Chrome.
2. `git lfs install`, poi clone del branch; controllare che `MarsTerrainData.asset` pesi 62,6 MB.
3. `Tools\homeline-data\fetch.ps1`, poi `dotnet run --project Tools/homeline-core/tests`.
4. Aprire in Unity; non committare modifiche a `ProjectSettings/` o `Packages/`.

## Calendario

| Quando | Cosa |
|---|---|
| Sab. sera | Logica completa e testata; prima build dell'exe; flusso titolo → pianificazione → replay |
| Dom. mattina | Cammino libero, giudizio dal vivo, marcatori, minimappa; unione del lavoro di cielo, casco e titolo |
| Dom. 13:00–14:00 | Ripresa della clip video con quello che funziona |
| Dom. 15:00 | Non si aggiunge più nulla |
| Dom. 15:30 | Build candidata |
| Dom. 17:30 | Build finale, collaudo su PC pulito e senza rete |
| Dom. 20:30 | Consegna |

**Ordine di taglio se si è in ritardo:** diario della missione → scostamento dal piano → minimappa → O₂ dal passo reale (resta quello della timeline).

## Verifica

1. **Test `dotnet`** (`Tools/homeline-core/tests`): bundle, piano, 68 casi `golden.json`, parità del margine sulle 20 righe, server locale.
2. **Compilazione fuori editor** (`unity_check.py`): 0 errori prima di ogni prova in Unity.
3. **In Unity:** il replay riproduce le righe della timeline (arrivo a S7 a 44,39 min, rientro a 325,94); il pad è dove dice il planner; uscendo dal percorso scatta l'allarme ambra, poi rosso.
4. **Flusso:** titolo → pianificazione → Start EVA dieci volte di fila; l'app torna in primo piano e i comandi rispondono senza clic; chiudendo il planner si torna al titolo.
5. **Exe:** avvio a freddo; funziona senza rete; all'uscita non restano processi del browser; dieci ingressi/uscite dal Play in Editor non lasciano processi né porte occupate.
6. **PC pulito:** scaricare lo zip, estrarre, avviare.

## Rischi e ripieghi

| Rischio | Ripiego |
|---|---|
| La prima build dell'exe fallisce o dura troppo | Togliere per la build i pacchetti in anteprima non usati (`ai.assistant`, `ai.inference`, `unity-mcp`, `com.unity.pipeline`) |
| L'aggancio alla schermata titolo non arriva | Avvio della pianificazione con un tasto dall'app; il titolo resta com'è |
| Il browser a tutto schermo si comporta male su un PC | Finestra normale senza barre; in ultima istanza browser predefinito |
| L'app non torna in primo piano | Messaggio "Click to begin EVA" |
| Poca memoria libera su PC 1 (4,5 GB) | Build e secondo editor sul PC 2 |
| Il lavoro di cielo/casco/titolo non viene committato in tempo | Il branch consegna con un pannello minimo proprio |
| Il terreno a 1 m finisce a 573 m a nord del pad | Etichetta "coarse terrain" |

## Dopo l'hackathon

- Ricalcolo del percorso con il motore Python del planner come processo affiancato (pad personalizzato, scelta delle stazioni). Servono le griglie a 3 m dell'autore del planner, che non sono in git.
- Cambio di scenario, con un bundle per scenario.
- Confronto piano/percorso reale nella web app.
- Terreno ricentrato sul pad ufficiale.
