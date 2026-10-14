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

### Basavbild för lokala speldockrar (Docker / OrbStack)

Den lokala Hetzner-emulatorn (spec #19) kör spelens oförändrade cloud-init `user_data` i Docker-containrar. Underlaget är en amd64-avbild med Ubuntu 22.04, systemd som PID 1 och cloud-init med datakällan NoCloud. Verifierat på OrbStack 2.2 / Apple Silicon.

**Uppsättning (Mac):**

1. Installera [OrbStack](https://orbstack.dev) (dokumenterad Docker-leverantör; bara Docker Engine API och vanliga Docker-funktioner används, så Colima och Docker på Linux fungerar också).
2. `pnpm local:image` bygger `starbound-panel-base:latest` (`docker/base/Dockerfile`, alltid `linux/amd64`; på Apple Silicon körs den via Rosetta).
3. `pnpm local:binfmt` (bara Apple Silicon, krävs för Starbound) registrerar en patchad qemu-i386 i Docker-VM:en. Se nedan. Registreringen försvinner troligen när OrbStack startas om (ej testat), kör då kommandot igen. Det är idempotent.
4. `docker/base/smoke.sh [antal]` kör rökprovet: första boot, omstart, commit + ny container med ny `instance-id` (upprepas).

**32-bitars steamcmd (Apple Silicon).** Rosetta kör inte 32-bitars x86; OrbStack skickar i386 till sin inbyggda qemu-i386 (skyddad, går inte att avregistrera). Den kör steamcmd bara delvis: självuppdateringen går bra men sedan kraschar den vid "Loading Steam API" med `Fatal error: futex robust_list not initialized by pthreads` (qemu-user svarar ENOSYS på `set/get_robust_list`). Detsamma gäller officiella qemu 10.2.3 (`tonistiigi/binfmt` kan inte heller ersätta posten). Lösningen i repot är `docker/qemu-i386/`: qemu 10.2.3 med en liten patch som minns robust-listan, registrerad som en *ny* binfmt-post (`qemu-i386-robust`, flaggor `OCF`). Kärnan provar den senast registrerade posten först, så den går före OrbStacks. Med den körs `steamcmd +login anonymous +quit` till slut, och Starbounds riktiga `user_data` når Steams inloggning. På en x86-Linux-maskin behövs inget av detta.

**Containerinställningar för systemd** (verifierade; `docker create` + start, ingen `--privileged`):

```
--platform linux/amd64
--cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw
--tmpfs /run --tmpfs /run/lock
--stop-signal SIGRTMIN+3 --stop-timeout 300
```

- Utan `--cgroupns=host` + skrivbar cgroup-mount, eller utan de två tmpfs-mounten, dör containern direkt och tyst (exit 255, ingen logg).
- `/tmp` behöver ingen tmpfs. `--privileged` fungerar också men behövs inte.
- Avbilden har `STOPSIGNAL SIGRTMIN+3` (systemds halt-signal; SIGTERM gör ingenting) och det följer med `docker commit`. Men host-inställningarna ovan (cgroup, tmpfs, portar, stop-timeout) följer **inte** med en commit och måste anges vid varje `docker create`.
- Stopp tar under en sekund; Factorio skriver sin sparfil vid stoppet (kontrollerat: `world.zip` ändras, markörfil överlever commit + restore).
- Portar publiceras med `-p 34197:34197/udp`, `-p 21025:21025/tcp -p 21025:21025/udp` med mera.

**NoCloud-seed.** Avbildens `/etc/cloud/cloud.cfg.d/99-nocloud.cfg` pekar på seed-katalogen `/var/lib/cloud/seed/nocloud/` med filerna `meta-data` (`instance-id: <unikt>`) och `user-data` (skriptet, `#!/bin/bash`). Lägg in dem med `docker create` följt av `docker cp <katalog>/. <container>:/var/lib/cloud/seed/nocloud/` (dockerode: `putArchive`) *innan* start; ingen bind mount behövs, och en ny seed skriver över gamla filer i en commitad avbild. Vänta på färdig cloud-init med `docker exec <c> cloud-init status --wait` (exit 1 och `status: error` om `user_data` misslyckades; logg i `/var/log/cloud-init-output.log`).

- Ny `instance-id` i en container skapad från en commitad avbild kör `user_data` igen (testat 5 cykler i rad). Samma `instance-id` kör det inte igen, och inte heller `docker restart`.
- Avbilden stänger av cloud-inits nätverkskonfiguration, `preserve_hostname` och omskrivning av apt-källor (`98-container.cfg`). Utan det kraschar cloud-init-local (`udevadm` saknas) och apt-källorna blir `UNAVAILABLE` (utan `lsb-release`).
- `user_data` använder `sudo`, `curl` och `ca-certificates`, som finns i avbilden. Allt annat installeras av skriptet själv (`apt-get update` första gången).

**Spelen i containern** (`user_data` ur spelregistret, oförändrad):

- Factorio (version `stable`, port 34197/udp): klart på ~15 s, `factorio.service` aktiv, kartan skapas, sparas vid `docker stop`, och återställs ur en commit med ny seed.
- Starbound: `apt`, `dpkg --add-architecture i386`, `steamcmd` och inloggningen mot Steam fungerar (kördes med falska uppgifter: `ERROR (Invalid Password)`). **Själva Starbound-installationen (app 211820) och att `starbound.service` startar är inte provad** (inga `STEAM_USER`/`STEAM_PASS` i miljön).

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
