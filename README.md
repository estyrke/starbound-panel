# Starbound Panel

En enkel kontrollpanel för att starta/stoppa Hetzner Cloud-servrar – byggd med React + Vercel Serverless Functions.

## Projektstruktur

```
starbound-panel/
├── api/
│   ├── servers.js      # GET  /api/servers   – listar alla servrar
│   └── action.js       # POST /api/action    – startar/stoppar server
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

## Deploy till Vercel

### 1. Pusha till GitHub

```bash
git init
git add .
git commit -m "init"
gh repo create starbound-panel --public --push --source .
```

### 2. Importera i Vercel

1. Gå till [vercel.com/new](https://vercel.com/new)
2. Välj ditt GitHub-repo
3. Klicka **Deploy** (inställningarna hämtas från `vercel.json` automatiskt)

### 3. Lägg till API-nyckel

1. Gå till **Project Settings → Environment Variables**
2. Lägg till:
   - **Name:** `HETZNER_API_TOKEN`
   - **Value:** din Hetzner API-nyckel (skapas på [console.hetzner.cloud](https://console.hetzner.cloud) → Security → API Tokens)
3. Klicka **Save** och kör ett nytt deploy (Vercel → Deployments → Redeploy)

## Lokal utveckling

```bash
npm install
```

Skapa en `.env.local`-fil:
```
HETZNER_API_TOKEN=din_nyckel_här
```

Starta Vercel dev-server (hanterar både frontend och API-routes):
```bash
npx vercel dev
```

## API-endpoints

| Metod | URL           | Beskrivning              |
|-------|---------------|--------------------------|
| GET   | /api/servers  | Lista alla servrar       |
| POST  | /api/action   | Utför åtgärd på server   |

### POST /api/action

```json
{
  "id": 12345,
  "action": "poweron"
}
```

Tillåtna actions: `poweron`, `poweroff`, `shutdown`, `reboot`

> **shutdown** skickar ACPI-signal (mjuk avstängning) – rekommenderas framför `poweroff`.
