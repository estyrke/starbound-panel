# Starbound Panel

Kontrollpanel för att hantera en Starbound-dedikerad server på Hetzner Cloud. Byggd med [TanStack Start](https://tanstack.com/start) (React + serverfunktioner i samma app).

Istället för att låta servern gå på tomgång sparas den ned som en snapshot och tas bort när du stänger av den. När du startar igen skapas en ny server från den senaste snapshoten – du betalar bara när du spelar.

## Hur det fungerar

| Åtgärd | Vad som händer |
|--------|----------------|
| **SPARA & STÄNG** | Mjuk avstängning → snapshot → servern raderas |
| **STARTA** (sovande) | Ny server skapas från senaste snapshot |
| **NYTT SPEL** | Ny server skapas från `ubuntu-22.04`, Starbound installeras via SteamCMD |
| **STARTA OM** | Vanlig omstart, ingen snapshot |

När servern är uppe uppdateras DNS-poster (A + AAAA) automatiskt hos Gandi.

Start- och stoppflödena körs stegvis från klienten: varje steg är ett kort serverfunktions-anrop (skapa, polla status, snapshot, radera), så ingen enskild HTTP-förfrågan behöver leva längre än några sekunder – viktigt vid serverless-deploy. Panelen kräver inloggning med lösenord (`PANEL_PASSWORD`); sessionen lagras i en krypterad httpOnly-cookie.

## Projektstruktur

```
starbound-server/
├── src/
│   ├── routes/
│   │   ├── __root.tsx          # HTML-skal, providers
│   │   └── index.tsx           # Panelen: login, serverkort, systemlogg
│   ├── lib/
│   │   ├── api.functions.ts    # Serverfunktioner (RPC) – kräver inloggning
│   │   ├── auth.functions.ts   # login / logout / getAuthStatus
│   │   ├── auth.middleware.ts  # 401-middleware för serverfunktionerna
│   │   ├── auth.server.ts      # Sessionshantering (krypterad cookie)
│   │   ├── hetzner.server.ts   # Hetzner Cloud-klient (endast server)
│   │   ├── gandi.server.ts     # Gandi LiveDNS-klient (endast server)
│   │   ├── flows.ts            # Klientorkestrering av start/stopp-stegen
│   │   ├── helpers.ts          # Rena hjälpfunktioner (enhetstestade)
│   │   └── types.ts
│   └── styles/
├── package.json
├── vite.config.ts
├── vitest.config.ts
└── vercel.json
```

## Miljövariabler

Sätt dessa under **Vercel → Project Settings → Environment Variables** (eller i `.env` lokalt).

### Obligatoriska

| Variabel | Beskrivning |
|----------|-------------|
| `HETZNER_API_TOKEN` | API-nyckel från [console.hetzner.cloud](https://console.hetzner.cloud) → Security → API Tokens |
| `PANEL_PASSWORD` | Lösenordet för att logga in i panelen |
| `SESSION_SECRET` | Hemlighet som krypterar sessionscookien, minst 32 tecken (t.ex. `openssl rand -hex 32`) |

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
| `SNAPSHOT_RETENTION_COUNT` | Antal snapshots som behålls per server | `2` |

### Första uppstart utan snapshot (valfria)

Krävs bara om ingen snapshot finns och du klickar **NYTT SPEL**. Starbound laddas ned via SteamCMD – kontot måste äga spelet och Steam Guard måste vara inaktiverat eller förauktoriserat för automatiserad inloggning.

| Variabel | Beskrivning |
|----------|-------------|
| `STEAM_USER` | Steam-användarnamn |
| `STEAM_PASS` | Steam-lösenord |

## Deploy till Vercel

1. Pusha repot till GitHub
2. Importera på [vercel.com/new](https://vercel.com/new) – Vercel har inbyggt stöd för TanStack Start
3. Lägg till miljövariablerna ovan under **Project Settings → Environment Variables** och kör ett nytt deploy

## Lokal utveckling

```bash
pnpm install
```

Skapa `.env` (gitignorerad) med variablerna ovan, sedan:

```bash
pnpm dev        # dev-server på http://localhost:3000
pnpm typecheck  # tsc --noEmit
pnpm lint       # eslint
pnpm test       # vitest
```

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

Hetzner-snapshots sparas med etiketten `managed=starbound-panel` och innehåller servernamn, typ och datacenter i labels – det är det panelen använder för att återskapa servern med samma konfiguration. De `SNAPSHOT_RETENTION_COUNT` senaste behålls per servernamn; äldre raderas automatiskt efter varje ny snapshot.
