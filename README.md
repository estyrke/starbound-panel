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

### DNS-leverantör

| Variabel | Beskrivning | Standard |
|----------|-------------|----------|
| `DNS_PROVIDER` | Vilken DNS-leverantör som uppdateras när servern startar: `gandi` eller `none`. Okänt värde ger ett tydligt fel. `none` gör inga nätverksanrop och loggar `localhost` med serverns IP-adresser (för lokal körning). | `gandi` |

### Gandi DNS (krävs när `DNS_PROVIDER=gandi`)

| Variabel | Beskrivning | Exempel |
|----------|-------------|---------|
| `GANDI_API_KEY` | API-nyckel från Gandi → User Settings → Security | |
| `GANDI_DOMAIN` | DNS-zonen (domänen) | `example.com` |
| `GANDI_RECORD` | Subdomän att uppdatera (`@` = root) | `play` |
| `GANDI_RECORD_STARBOUND` | Subdomän för Starbound (faller tillbaka på `GANDI_RECORD`) | `play` |
| `GANDI_RECORD_FACTORIO` | Subdomän för Factorio | `factorio` |

DNS-posterna `play.example.com A` och `play.example.com AAAA` sätts automatiskt när servern startar. TTL 300 s.

### Serverinställningar (valfria)

| Variabel | Beskrivning | Standard |
|----------|-------------|---------|
| `SERVER_NAME` | Namn på servern i Hetzner | `starbound` |
| `HETZNER_SERVER_TYPE` | Servertyp | `cx23` |
| `HETZNER_SERVER_TYPE_FACTORIO` | Servertyp för Factorio | `cx33` |
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
2. Importera på [vercel.com/new](https://vercel.com/new) – bygget använder [Nitro](https://nitro.build) (`nitro/vite` i `vite.config.ts`), som automatiskt genererar Vercels Build Output (`.vercel/output`). Sätt ingen egen *Output Directory* i Vercel.
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

### Lokalt med fejkade API:er

För att prova GUI och flöden utan att röra Hetzner, Gandi eller factorio.com:

```bash
pnpm dev:fake   # panel på http://localhost:3000, lösenord: fake
```

Kommandot startar en lokal fejkserver (port 4010) tillsammans med dev-servern och sätter engångsvärden för alla nycklar, så ingen `.env` behövs och riktiga nycklar kan aldrig användas av misstag. Fejkserverna:

- **Hetzner**: stateful i minnet. Servrar går `initializing` → `running`, avstängning ger `off`, snapshots blir tillgängliga efter några sekunder. Startar med en levande Starbound-server (`starbound`) och en sovande Factorio-värld (`factory`, äldre version).
- **Gandi**: lagrar A/AAAA-poster i minnet och loggar varje uppdatering. Aktuella poster: `http://127.0.0.1:4010/gandi/_debug/records`.
- **factorio.com**: svarar på `latest-releases` med en fast version.

Ingen riktig spelserver körs. Tillståndet nollställs vid varje omstart. Justera hastigheten med `FAKE_ACTION_DELAY_MS` (standard 2500) och porten med `FAKE_UPSTREAMS_PORT`.

Panelen läser bas-URL:erna från `HETZNER_API_URL`, `GANDI_API_URL` och `FACTORIO_API_URL`; utan dem används de riktiga tjänsterna.

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

### Factorio (valfria)

Ny Factorio-värld startas med spelet `factorio` och installerar senaste stabila headless-version (hämtas från `factorio.com/api/latest-releases`; går den inte att läsa nekas en ny värld). Space Age, Quality och Elevated Rails är avstängda. Servern är olistad och nås via spelets DNS-post på UDP 34197.

| Variabel | Beskrivning |
|----------|-------------|
| `FACTORIO_GAME_PASSWORD` | Lösenord för att ansluta (valfritt) |
| `FACTORIO_ADMINS` | Kommaseparerad lista med admin-användarnamn |

Felsökning:

```bash
ssh root@<server-ip>
journalctl -u factorio -n 50
cat /var/log/cloud-init-output.log   # om installationen misslyckades
```

Filerna ligger under `/opt/factorio/`, sparfilen är `saves/world.zip`. Servern stoppas med SIGTERM så att spelet hinner spara (`TimeoutStopSec=300`). Version sparas i etiketten `factorio-version` på servrar och snapshots.

### Snapshot

Hetzner-snapshots sparas med etiketten `managed=starbound-panel` och innehåller servernamn, typ och datacenter i labels – det är det panelen använder för att återskapa servern med samma konfiguration. De `SNAPSHOT_RETENTION_COUNT` senaste behålls per servernamn; äldre raderas automatiskt efter varje ny snapshot.
