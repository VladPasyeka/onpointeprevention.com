# OnPointe Prevention

## MVP Summary (10 bullets)
1. OnPointe is a proactive injury-prevention app for dancer/actor-mover users, not a post-injury rehab clinic app.
2. Dancers use a low-friction daily check-in to log training load and recovery signals quickly.
3. Load monitoring is central: session load and trend/risk context are surfaced for decision support.
4. Risk alerts are generated from check-in patterns and delivered to PT workflows.
5. PT users need a dedicated portal to monitor linked dancers and open dancer details.
6. PTs need automation-first views so oversight does not become a manual time burden.
7. Messaging must support PT <-> dancer communication in familiar chat patterns.
8. Availability supports scheduling coordination between dancers and PTs.
9. Education/resources should feel supportive and practical for chaotic performing schedules.
10. Privacy and data ownership must be explicit, with role-based access and restricted data visibility.

## Run Locally
1. Install root dependencies for functions if needed:
   - `cd functions`
   - `npm install`
2. From repo root, run Firebase emulators (hosting + auth + firestore + functions):
   - `firebase emulators:start --only functions,firestore,auth,hosting`
3. Open the local Hosting URL shown by emulator output.

## Firebase Configuration
- `firebase.json` expects:
  - Hosting from `public/`
  - Functions from `functions/`
  - Firestore rules from `firestore.rules`
  - Firestore indexes from `firestore.indexes.json`
- Frontend calls Gen2 HTTPS functions at:
  - Prod: `https://us-central1-on-pointe-prevention.cloudfunctions.net`
  - Local emulator: `http://127.0.0.1:5001/on-pointe-prevention/us-central1`

## Deploy Rules / Indexes / Functions / Hosting
1. Deploy Firestore rules and indexes:
   - `firebase deploy --only firestore:rules,firestore:indexes`
2. Deploy Cloud Functions:
   - `firebase deploy --only functions`
3. Deploy Hosting:
   - `firebase deploy --only hosting`

## Demo Seed Helper
- PT users can press `Seed demo dancer + chat` in **PT Portal**.
- This calls `seedDemoData` (Cloud Function) to create:
  - one demo linked dancer
  - one sample check-in
  - one sample PT<->dancer thread with starter messages
