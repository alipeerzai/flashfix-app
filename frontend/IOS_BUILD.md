# FlashFix TX iOS Build

The iOS wrapper is ready in `frontend/ios`.

## Important

An iPhone app cannot call `http://localhost:4000` on this Windows PC. Before a real iOS release, deploy the backend to a hosted HTTPS URL and set:

```powershell
VITE_API_URL=https://your-backend-url.com
```

The installed app also has a `Backend Settings` panel on the sign-in screen so the backend URL can be changed without rebuilding.

## Build On macOS

1. Install Node.js and Xcode on the Mac.
2. Copy this `frontend` folder to the Mac.
3. Open Terminal in the `frontend` folder.
4. Run:

```bash
npm install
npm run ios:sync
npm run ios:open
```

5. In Xcode:
   - Select the `App` target.
   - Set the Apple Developer Team.
   - Confirm bundle id: `com.flashfixtx.appliancerepair`.
   - Build to an iPhone, archive for TestFlight, or export an `.ipa`.

## Local Development

```powershell
npm.cmd run dev -- --host 127.0.0.1 --port 5173
```

## Native Assets

- App icon: `public/app-icon-1024.png`
- Apple touch icon: `public/apple-touch-icon.png`
- Splash: `public/splash-2732.png`
- Xcode project: `ios/App/App.xcodeproj`
