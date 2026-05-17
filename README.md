# Starbound Panel

Kontrollpanel för att hantera en Starbound-dedikerad server på Hetzner Cloud. Byggd med React + Vercel Serverless Functions.

Istället för att låta servern gå på tomgång sparas den ned som en snapshot och tas bort när du stänger av den. När du startar igen skapas en ny server från den senaste snapshoten – du betalar bara när du spelar.

## Hur det fungerar

| Åtgärd | Vad som händer |
|--------|----------------|
| **SPARA & STÄNG** | Mjuk avstängning → snapshot → servern raderas |
| **STARTA** (sovande) | Ny server skapas från senaste snapshot |
| **NYTT SPEL** | Ny server skapas från `ubuntu-22.04`, Starbound installeras via SteamCMD |
| **STARTA OM** | Vanlig omstart, ingen snapshot |

När servern är uppe uppdateras DNS-poster (A + AAAA) automatiskt hos Gandi.

## Projektstruktur

```
starbound-panel/
├── api/
│   ├── servers.js         # GET  /api/servers        – lista servrar
│   ├── action.js          # POST /api/action         – reboot / poweron
│   ├── snapshot.js        # POST /api/snapshot       – skapa snapshot
│   ├── snapshots.js       # GET  /api/snapshots      – lista snapshots
│   ├── delete-server.js   # DELETE /api/delete-server
│   ├── create-server.js   # POST /api/create-server  – skapa från snapshot eller cloud-init
│   ├── poll-action.js     # GET  /api/poll-action    – poll Hetzner action-status
│   └── update-dns.js      # POST /api/update-dns     – uppdatera Gandi A + AAAA
├── src/
│   ├── main.jsx
│   ├── App.jsx
│   ├── App.module.css
│   └── index.css
├── index.html
├── package.json
├── vite.config.js
└── vercel.json
```

## Miljövariabler

Sätt dessa under **Vercel → Project Settings → Environment Variables**.

### Obligatorisk

| Variabel | Beskrivning |
|----------|-------------|
| `HETZNER_API_TOKEN` | API-nyckel från [console.hetzner.cloud](https://console.hetzner.cloud) → Security → API Tokens |

### Gandi DNS (krävs för automatisk DNS-uppdatering)

| Variabel | Beskrivning | Exempel |
|----------|-------------|---------|
| `GANDI_API_KEY` | API-nyckel från Gandi → User Settings → Security | |
| `GANDI_DOMAIN` | DNS-zonen (domänen) | `example.com` |
| `GANDI_RECORD` | Subdomän att uppdatera (`@` = root) | `play` |

DNS-posterna `play.example.com A` och `play.example.com AAAA` sätts automatiskt när servern startar. TTL 300 s.

### Serverinställningar (valfria)

| Variabel | Beskrivning | Standard |
|----------|-------------|---------|
| `SERVER_NAME` | Namn på servern i Hetzner | `starbound` |
| `HETZNER_SERVER_TYPE` | Servertyp | `cx23` |
| `HETZNER_LOCATION` | Datacenter | `hel1` |

### Första uppstart utan snapshot (valfria)

Krävs bara om ingen snapshot finns och du klickar **NYTT SPEL**. Starbound laddas ned via SteamCMD – kontot måste äga spelet och Steam Guard måste vara inaktiverat eller förauktoriserat för automatiserad inloggning.

| Variabel | Beskrivning |
|----------|-------------|
| `STEAM_USER` | Steam-användarnamn |
| `STEAM_PASS` | Steam-lösenord |

## Deploy till Vercel

### 1. Pusha till GitHub

```bash
git init
git add .
git commit -m "init"
gh repo create starbound-panel --private --push --source .
```

### 2. Importera i Vercel

1. Gå till [vercel.com/new](https://vercel.com/new)
2. Välj ditt GitHub-repo
3. Klicka **Deploy** – inställningarna hämtas från `vercel.json` automatiskt

### 3. Lägg till miljövariabler

Gå till **Project Settings → Environment Variables** och lägg till variablerna ovan. Kör sedan ett nytt deploy (Deployments → Redeploy).

## Lokal utveckling

```bash
npm install
```

Skapa `.env.local`:
```
HETZNER_API_TOKEN=...
GANDI_API_KEY=...
GANDI_DOMAIN=example.com
GANDI_RECORD=play
```

Starta:
```bash
npx vercel dev
```

`vercel dev` kör både API-funktionerna och frontend-servern (Vite) i en process. Öppna URL:en som skrivs ut – vanligtvis `http://localhost:3000`.

## Felsökning

### Cloud-init / första installation

SSH in på servern och kör:
```bash
# Följ installationsloggen live
tail -f /var/log/cloud-init-output.log

# Kontrollera att tjänsten startade
systemctl status starbound

# Loggar från spelservern
journalctl -u starbound -n 50
```

Starbound-filerna hamnar under `/home/steam/starbound/`.

### Snapshot

Hetzner-snapshots sparas med etiketten `managed=starbound-panel` och innehåller servernamn, typ och datacenter i labels – det är det panelen använder för att återskapa servern med samma konfiguration.
