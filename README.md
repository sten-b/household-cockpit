# Household Cockpit

Personal finance PWA — Bunq + Alpaca + AI insights.

## Deploy to Vercel

1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → New Project → Import your GitHub repo
3. Set **Root Directory** to `public`
4. Click Deploy — done

## First run

1. Open the app on your phone
2. Tap **Settings** (⚙️ top right)
3. Paste your API keys:
   - **Bunq**: Production API key (read-only recommended)
   - **Alpaca**: Key ID + Secret (paper trading)
   - **Anthropic**: `sk-ant-...` key for AI insights
4. Tap **Save & connect**

## Install as app (PWA)

**iOS**: Safari → Share → Add to Home Screen  
**Android**: Chrome → ⋮ menu → Add to Home Screen

## Structure

```
public/
  index.html      # App shell
  style.css       # All styles
  app.js          # Logic, API calls, charts
  sw.js           # Service worker (offline)
  manifest.json   # PWA manifest
  icons/          # App icons
vercel.json       # Vercel routing config
```

## Keys are stored locally

All API keys are stored in your browser's `localStorage` only.  
They are sent directly to Bunq/Alpaca/Anthropic — never via any intermediary server.
