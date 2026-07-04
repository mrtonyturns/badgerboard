# BadgerBoard Mobile (iOS + Android)

The web app is wrapped with [Capacitor](https://capacitorjs.com). One codebase — the same React app that runs at badgerboardwi.com is bundled into native iOS and Android shells, supporting phones and tablets.

## What's different in the native app

| Area | Behavior |
|---|---|
| API calls | `/.netlify/functions/*` calls are routed to `https://badgerboardwi.com` through the native HTTP layer (`src/lib/native.js`) — no CORS changes needed on the backend. |
| Payments | All Stripe purchase/upgrade/billing UI is hidden in native builds (App Store / Play Store rules for digital subscriptions). Users subscribe on the website; the app is sign-in only. |
| Offline reads | Recently viewed dossiers, candidates, elections, offices, and activity are cached on-device (`src/lib/offlineCache.js`) and served when offline. |
| Offline writes | Door-knock logging already queues via `src/lib/offlineQueue.js` and syncs on reconnect. |
| Service worker | Skipped in native builds (assets are bundled locally). |

`isNativeApp` from `src/lib/native.js` is the flag for any future platform-specific UI.

## Build & run

```bash
npm install
cp .env.example .env    # fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
npm run build           # builds web assets into dist2/
npx cap sync            # copies dist2/ into ios/ and android/

npx cap open ios        # opens Xcode (macOS + Xcode required)
npx cap open android    # opens Android Studio
```

After any web-code change: `npm run build && npx cap sync`, then rebuild in Xcode/Android Studio.

## Store submission

See `MOBILE_LAUNCH_GUIDE` (delivered separately) for the full step-by-step:
developer account signup, signing, TestFlight/internal testing, store listings,
privacy declarations, and review notes.

## Key files

- `capacitor.config.json` — app id `com.thebluejackgroup.badgerboard`, splash config
- `assets/` — source icon/splash art; regenerate with `npx @capacitor/assets generate --ios --android`
- `ios/`, `android/` — native projects (committed; open directly in Xcode / Android Studio)
