# Oasis UK Steel Doors — V8.5 Android Studio Project

Clean Android Studio project for building the V8.5 secure client.

## Build APK
1. Open this `android` project folder in Android Studio.
2. Allow Gradle sync and install the Android SDK components requested by Android Studio.
3. Select **Build → Build APK(s)**.
4. APK output: `app/build/outputs/apk/debug/app-debug.apk`.

For a release APK, use **Build → Generate Signed App Bundle / APK** and configure your own signing key.

## Security posture
- V8.5 business data is memory-only in the Android WebView bridge.
- SQLite persistence is removed from the Android client.
- WebView database storage is disabled.
- Android app backup/data extraction is disabled.
- Cleartext HTTP is disabled; the backend must use HTTPS.
- Server authorization remains the authoritative security boundary.

Do not embed production secrets, database credentials, or bootstrap secrets in this APK.
