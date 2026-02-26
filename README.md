# MyEyes Prescriber Map

Interactive map for the ambassador team to find nearby prescribers who can write HOME2 prescriptions. A patient gives their zip code, the ambassador searches, and sees nearby doctors with contact info.

**Live site:** https://myeyes-prescriber-map.onrender.com (once deployed)

## Quick Start (Local)

```bash
# 1. Install dependencies
npm install

# 2. Copy and fill in API keys (AC credentials are pre-filled)
cp .env.example .env
# Edit .env — add GOOGLE_PLACES_API_KEY if you want address enrichment

# 3. Fetch prescriber data from ActiveCampaign + geocode addresses
npm run fetch

# 4. Launch the map
npm start
# Opens http://localhost:8080
```

## API Keys Required

| Key | Required | Purpose | Where to get it |
|-----|----------|---------|----------------|
| `ACTIVECAMPAIGN_URL` | Yes | AC account URL | Already set to `myeyes.activehosted.com` |
| `ACTIVECAMPAIGN_API_KEY` | Yes | AC API access | Settings > Developer in ActiveCampaign |
| `GOOGLE_PLACES_API_KEY` | No | Enrich with healthcare system names | [Google Cloud Console](https://console.cloud.google.com/apis/credentials) — enable Places API |

## Refreshing Data & Deploying

The prescriber data is a static JSON file checked into the repo. To update it:

```bash
# 1. Refresh data from ActiveCampaign (~13 min for geocoding)
npm run fetch

# 2. Commit and push — Render auto-deploys from main
git add data/prescribers.json public/prescribers.json
git commit -m "Refresh prescriber data"
git push
```

With Google Places enrichment (optional):
```bash
node fetch-prescribers.js --enrich
```

Preview without writing files:
```bash
node fetch-prescribers.js --dry-run
```

## Render Deployment

This is deployed as a **Static Site** on Render.

### Setup steps (one-time)
1. Go to [Render Dashboard](https://dashboard.render.com/) > **New** > **Static Site**
2. Connect the GitHub repo: `msv-me/myeyes-prescriber-map`
3. Configure:
   - **Name:** `myeyes-prescriber-map`
   - **Branch:** `main`
   - **Build Command:** leave blank (or `echo "static"`)
   - **Publish Directory:** `./public`
4. Click **Create Static Site**

No environment variables are needed on Render — the site is purely static. All data lives in `public/prescribers.json` which is committed to the repo.

The AC API key is only used locally when running `npm run fetch`.

### Auto-deploy
Every push to `main` triggers a redeploy on Render. So the workflow is:
1. Run `npm run fetch` locally
2. `git add . && git commit -m "Refresh prescriber data" && git push`
3. Render picks it up automatically

## How It Works

1. **Data pipeline** (`fetch-prescribers.js`) — run locally:
   - Fetches all contacts tagged "Doctor - Referring Doctor" (tag ID 45) from ActiveCampaign
   - Extracts address, specialty, NPI, contact info from custom fields
   - Geocodes each address to lat/lng using Nominatim (free) or Google Geocoding
   - Optionally enriches with Google Places to find healthcare system affiliation
   - Outputs `data/prescribers.json` + `public/prescribers.json`

2. **Frontend** (`public/`) — deployed on Render:
   - Static HTML/JS/CSS — no backend needed
   - Leaflet.js map with marker clustering
   - Zip code search with configurable radius (10/25/50/100/250 miles)
   - Click pins for doctor details, phone, email, distance
   - List view below map with click-to-zoom

## Data Source

Prescribers come from ActiveCampaign with these fields:
- Name, email, phone (contact fields)
- Organization / practice name
- Mailing address (fields 4-8)
- Specialty / prescriber type (fields 9, 111)
- NPI number (field 32)

## Project Structure

```
myeyes-prescriber-map/
├── fetch-prescribers.js    # Data pipeline (run locally)
├── render.yaml             # Render deployment config
├── data/
│   └── prescribers.json    # Generated data (committed)
├── public/                 # ← Render serves this directory
│   ├── index.html
│   ├── prescribers.json    # Data for frontend
│   ├── css/style.css
│   └── js/app.js
├── .env                    # API keys (gitignored)
├── .env.example            # Template
└── package.json
```
