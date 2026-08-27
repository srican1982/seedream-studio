# Seedream Studio

Mobile-first web app for **Runware** Seedream (images) and Seedance (video). Each model tab keeps its own uploads, prompt, settings, and result.

## What you get

- **Images:** Seedream 5.0 Pro, 5.0 Lite, 4.5
- **Video:** Seedance 2.5 Pro, 2.0 Lite, 1.5 Pro
- Add as many reference images as the model allows (N per tab, stored separately)
- Safety checker **off by default** (`safety.checkContent: false`)
- Inputs sent inline as data URIs (never uploaded to object storage)
- Generated URLs use **TTL 60 seconds**, then Runware wipes them
- Download button copies the file to your phone first

## Run on your computer / phone browser

```bash
npm install
copy .env.example .env
```

Put your Runware key in `.env`:

```
RUNWARE_API_KEY=your_key_here
PORT=8787
```

Then:

```bash
npm run dev
```

- Computer: http://localhost:5173
- Phone on the same Wi‑Fi: `http://YOUR_PC_IP:5173`

Production (PWA you can Add to Home Screen):

```bash
npm start
```

Open `http://YOUR_PC_IP:8787` on the phone → Chrome menu → **Add to Home screen**.

## Push to GitHub

Do **not** commit `.env`. The key stays in GitHub Secrets.

```bash
git init
git add .
git commit -m "Seedream Studio for Runware"
git branch -M main
git remote add origin https://github.com/YOUR_USER/seedream-studio.git
git push -u origin main
```

Add repository secret `RUNWARE_API_KEY`.

## Installable Android APK

GitHub → **Actions** → **Android APK** → **Run workflow**. When it finishes, download the debug APK artifact to your phone.

The APK talks to Runware directly. On first launch, paste your API key in **Settings** (gear icon) unless you also set the `RUNWARE_API_KEY` GitHub secret so CI can bake a device config.

## Deploy a live preview (Render / Railway)

This repo includes a `Dockerfile`. Deploy the container, set `RUNWARE_API_KEY`, then open the URL on your phone.

## Privacy notes

- Reference images never leave the request body (base64 data URI)
- Outputs: images as `dataURI`; videos as URL with `ttl: 60`
- After you tap Download, the app also tries `mediaStorage` delete
