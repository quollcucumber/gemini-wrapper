# Gemini Chat — Setup Guide

A secure Gemini chat app. Frontend + API hosted on Vercel (free). Auth + Firestore on Firebase (free tier).

---

## What you need

- A [Vercel account](https://vercel.com) (free, no credit card)
- A [Firebase project](https://console.firebase.google.com) (gemini-wrapper-52e4b)
- A [Gemini API key](https://aistudio.google.com/app/apikey)
- [Git](https://git-scm.com) installed

---

## Step 1 — Firebase Console setup

### Enable Authentication
1. Go to [console.firebase.google.com](https://console.firebase.google.com) → your project
2. **Build → Authentication → Get started**
3. Under **Sign-in method**, enable **Google**
4. Add your Vercel domain to **Authorized domains** after you deploy (e.g. `gemini-wrapper.vercel.app`)

### Enable Firestore
1. **Build → Firestore Database → Create database**
2. Choose **Start in production mode**
3. Pick a region (e.g. `us-central1`)

---

## Step 2 — Get a Firebase service account key

The Vercel function needs to verify Firebase auth tokens server-side.

1. In Firebase Console → **Project settings → Service accounts**
2. Click **Generate new private key** → download the JSON file
3. Open it — you need these three values:
   - `project_id`
   - `client_email`
   - `private_key`

---

## Step 3 — Push to GitHub

Vercel deploys from Git.

```bash
cd ~/gemini-wrapper
git init
git add .
git commit -m "Initial commit"
# Create a new repo on github.com, then:
git remote add origin https://github.com/YOUR_USERNAME/gemini-wrapper.git
git push -u origin main
```

---

## Step 4 — Deploy on Vercel

1. Go to [vercel.com/new](https://vercel.com/new)
2. Import your GitHub repo
3. Leave all build settings as default — Vercel detects the config automatically
4. Before clicking **Deploy**, add these **Environment Variables**:

| Name | Value |
|------|-------|
| `GEMINI_API_KEY` | Your Gemini API key |
| `FIREBASE_PROJECT_ID` | `gemini-wrapper-52e4b` |
| `FIREBASE_CLIENT_EMAIL` | `client_email` from service account JSON |
| `FIREBASE_PRIVATE_KEY_B64` | See below ↓ |

### Encoding the private key
The private key contains newlines which break environment variables. Encode it as base64 first:

**On Mac/Linux:**
```bash
echo '-----BEGIN RSA PRIVATE KEY-----\n...' | base64 -w 0
# or from the JSON file:
node -e "const k = require('./service-account.json').private_key; console.log(Buffer.from(k).toString('base64'))"
```

**On Windows (PowerShell):**
```powershell
[Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes((Get-Content service-account.json | ConvertFrom-Json).private_key))
```

Paste the base64 output as the `FIREBASE_PRIVATE_KEY_B64` value.

5. Click **Deploy** — you'll get a URL like `https://gemini-wrapper-abc123.vercel.app`

---

## Step 5 — Add Vercel domain to Firebase Auth

1. Firebase Console → **Authentication → Settings → Authorized domains**
2. Click **Add domain** → paste your Vercel URL (without `https://`)

---

## Project structure

```
gemini-wrapper/
├── public/
│   ├── index.html      # Frontend chat UI
│   └── style.css       # Styles
├── api/
│   └── chat.js         # Vercel serverless function (Gemini proxy)
├── firestore.rules     # Firestore security rules
├── firebase.json       # Firebase Hosting config (optional)
├── vercel.json         # Vercel routing config
└── package.json        # Dependencies for the API function
```

---

## How it works

```
Browser (school wifi)
  │
  ▼
Vercel  ── serves public/index.html + style.css
  │
  ▼  (user sends a message)
Vercel /api/chat  (serverless function)
  │  ← verifies Firebase ID token
  │  ← checks daily rate limit (Firestore)
  │  ← loads chat history (Firestore)
  │
  ▼
Gemini API  ← API key in Vercel env vars, never in the browser
  │
  ▼
Response saved to Firestore, returned to browser
```

School wifi only sees traffic to `*.vercel.app` — not Gemini's domains.

---

## Optional — Restrict to your account only

In `api/chat.js`, after the token is verified, add:

```js
const ALLOWED_EMAILS = ["your.email@gmail.com"];
const decoded = await auth.verifyIdToken(idToken);
if (!ALLOWED_EMAILS.includes(decoded.email)) {
  return res.status(403).json({ error: "Not authorized." });
}
```
