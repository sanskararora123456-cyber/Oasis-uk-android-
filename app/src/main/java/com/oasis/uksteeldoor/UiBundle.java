package com.oasis.uksteeldoor;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Base64;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.KeyFactory;
import java.security.MessageDigest;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.Locale;

/**
 * The app's screens, and keeping them up to date.
 *
 * The whole interface is one HTML file. It ships inside the APK, but the server
 * can offer a newer one, so a change to a screen does not mean building an APK
 * and walking round every phone.
 *
 * Three things keep that from being reckless:
 *
 *   Off unless enabled. Without assets/update-key.pub in the APK there is no key
 *   to check a signature against, and nothing is ever fetched. A build with no
 *   key behaves exactly as it always did.
 *
 *   Signed. A downloaded bundle must carry an RSA signature made by the matching
 *   private key, over bytes whose SHA-256 also has to match. Whoever holds the
 *   server cannot make a phone run code without that key.
 *
 *   It can always go back. The bundled copy is never deleted. A downloaded one
 *   is used only after it has started successfully once; if it fails to start,
 *   the next launch throws it away and uses the built-in screens again. That is
 *   the case that matters — a bundle that parses on a desktop but not on an old
 *   WebView would otherwise leave the shop with an app that will not open.
 *
 * Everything here fails towards the bundled copy. Any exception, anywhere, and
 * the app runs the screens it was built with.
 */
final class UiBundle {
    private static final String TAG = "OasisUi";

    private static final String PREFS = "oasis-ui";
    private static final String KEY_ACTIVE_VERSION = "active_version";
    private static final String KEY_STAGED_VERSION = "staged_version";
    private static final String KEY_BOOT_PENDING = "boot_pending";
    private static final String KEY_LAST_CHECK = "last_check";

    /** How often to ask the server, at most. */
    private static final long CHECK_EVERY_MS = 6 * 60 * 60 * 1000L;

    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;
    /** A bundle far bigger than the real one is a mistake or an attack. */
    private static final int MAX_BUNDLE_BYTES = 12 * 1024 * 1024;

    private final Context context;
    private final SharedPreferences prefs;

    UiBundle(Context context) {
        this.context = context.getApplicationContext();
        this.prefs = this.context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /* ------------------------------- where things live ---------------------- */

    private File dir() {
        File d = new File(context.getFilesDir(), "ui");
        if (!d.exists()) d.mkdirs();
        return d;
    }

    /** The file the WebView always loads. Keeping the address the same whichever
     *  copy is in use means the page keeps its stored settings across updates. */
    File servedFile() {
        return new File(dir(), "index.html");
    }

    private File stagedFile() {
        return new File(dir(), "staged.html");
    }

    String servedUrl() {
        return "file://" + servedFile().getAbsolutePath();
    }

    /* --------------------------------- startup ------------------------------ */

    /**
     * Decide which screens this launch uses, and put them where the WebView
     * expects them. Called before the page is loaded.
     */
    void prepare() {
        try {
            // A downloaded bundle that was given its chance last launch and never
            // reported starting is not given another one.
            if (prefs.getBoolean(KEY_BOOT_PENDING, false)) {
                int failed = prefs.getInt(KEY_ACTIVE_VERSION, 0);
                Log.w(TAG, "release " + failed + " did not start; going back to the built-in screens");
                prefs.edit()
                        .putBoolean(KEY_BOOT_PENDING, false)
                        .putInt(KEY_ACTIVE_VERSION, 0)
                        .putInt(KEY_STAGED_VERSION, 0)
                        .apply();
                deleteQuietly(stagedFile());
                installBundled();
                return;
            }

            // A bundle downloaded since the last launch takes over now.
            int staged = prefs.getInt(KEY_STAGED_VERSION, 0);
            if (staged > 0 && stagedFile().exists()) {
                copy(stagedFile(), servedFile());
                deleteQuietly(stagedFile());
                prefs.edit()
                        .putInt(KEY_ACTIVE_VERSION, staged)
                        .putInt(KEY_STAGED_VERSION, 0)
                        .putBoolean(KEY_BOOT_PENDING, true)
                        .apply();
                Log.i(TAG, "starting with release " + staged);
                return;
            }

            // Otherwise keep whatever is already there, and make sure something is.
            if (!servedFile().exists()) installBundled();
        } catch (Throwable t) {
            Log.e(TAG, "could not prepare the screens; using the built-in ones", t);
            try {
                installBundled();
            } catch (Throwable ignored) {
                // Nothing more can be done here; MainActivity falls back to the
                // asset URL directly.
            }
        }
    }

    /** The page telling us it got as far as drawing itself. */
    void bootSucceeded() {
        if (prefs.getBoolean(KEY_BOOT_PENDING, false)) {
            prefs.edit().putBoolean(KEY_BOOT_PENDING, false).apply();
            Log.i(TAG, "release " + prefs.getInt(KEY_ACTIVE_VERSION, 0) + " started cleanly");
        }
    }

    int activeVersion() {
        return prefs.getInt(KEY_ACTIVE_VERSION, 0);
    }

    private void installBundled() {
        try {
            InputStream in = context.getAssets().open("index.html");
            writeTo(in, servedFile());
            prefs.edit().putInt(KEY_ACTIVE_VERSION, 0).apply();
        } catch (Throwable t) {
            Log.e(TAG, "could not copy the built-in screens", t);
            deleteQuietly(servedFile());
        }
    }

    /* -------------------------------- the key ------------------------------- */

    /** The public key built into this APK, or null when updates are switched off. */
    private PublicKey signingKey() {
        try {
            InputStream in = context.getAssets().open("update-key.pub");
            String base64 = new String(readAll(in, 8192), "UTF-8").trim();
            if (base64.isEmpty()) return null;
            byte[] der = Base64.decode(base64, Base64.DEFAULT);
            return KeyFactory.getInstance("RSA").generatePublic(new X509EncodedKeySpec(der));
        } catch (Throwable t) {
            // Missing asset is the normal "updates are off" case, not an error.
            return null;
        }
    }

    boolean updatesEnabled() {
        return signingKey() != null;
    }

    /* ------------------------------- fetching ------------------------------- */

    /**
     * Ask the server whether there is a newer set of screens and, if there is,
     * fetch and check it. Runs on its own thread; nothing here touches the UI.
     *
     * The new bundle is only staged — it is used from the next launch, never
     * swapped in underneath someone who is in the middle of something.
     */
    void checkInBackground(final String serverUrl) {
        final PublicKey key = signingKey();
        if (key == null) return;
        if (serverUrl == null || !serverUrl.toLowerCase(Locale.US).startsWith("https://")) {
            // Only over a connection that cannot be tampered with in transit.
            return;
        }
        long since = System.currentTimeMillis() - prefs.getLong(KEY_LAST_CHECK, 0L);
        if (since < CHECK_EVERY_MS) return;

        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    check(serverUrl, key);
                } catch (Throwable t) {
                    Log.w(TAG, "update check failed: " + t.getMessage());
                }
            }
        }, "oasis-ui-update").start();
    }

    private void check(String serverUrl, PublicKey key) throws Exception {
        prefs.edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply();

        String base = serverUrl.endsWith("/") ? serverUrl.substring(0, serverUrl.length() - 1) : serverUrl;
        String manifest = new String(fetch(base + "/v1/app/manifest", 64 * 1024), "UTF-8");

        if (!jsonBool(manifest, "available")) return;
        int version = (int) jsonNumber(manifest, "version");
        String expectedSha = jsonString(manifest, "sha256");
        String signature = jsonString(manifest, "signature");
        if (version <= 0 || expectedSha == null || signature == null) return;

        int have = Math.max(prefs.getInt(KEY_ACTIVE_VERSION, 0), prefs.getInt(KEY_STAGED_VERSION, 0));
        if (version <= have) return;

        byte[] bundle = fetch(base + "/v1/app/bundle?version=" + version, MAX_BUNDLE_BYTES);

        if (!hex(MessageDigest.getInstance("SHA-256").digest(bundle)).equals(expectedSha)) {
            Log.w(TAG, "release " + version + " did not match its stated contents; ignored");
            return;
        }
        Signature check = Signature.getInstance("SHA256withRSA");
        check.initVerify(key);
        check.update(bundle);
        if (!check.verify(Base64.decode(signature, Base64.DEFAULT))) {
            Log.w(TAG, "release " + version + " is not signed by the key this app trusts; ignored");
            return;
        }
        // Cheap sanity check that this is the app and not something else entirely.
        String head = new String(bundle, 0, Math.min(bundle.length, 4096), "UTF-8");
        if (!head.contains("<script")) {
            Log.w(TAG, "release " + version + " does not look like the app; ignored");
            return;
        }

        writeTo(bundle, stagedFile());
        prefs.edit().putInt(KEY_STAGED_VERSION, version).apply();
        Log.i(TAG, "release " + version + " is ready; it will be used next time the app starts");
    }

    private byte[] fetch(String url, int limit) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        try {
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestProperty("Accept", "*/*");
            if (connection.getResponseCode() != 200) {
                throw new Exception("server said " + connection.getResponseCode());
            }
            return readAll(connection.getInputStream(), limit);
        } finally {
            connection.disconnect();
        }
    }

    /* -------------------------------- plumbing ------------------------------ */

    private static byte[] readAll(InputStream in, int limit) throws Exception {
        try {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
                if (out.size() > limit) throw new Exception("more data than expected");
            }
            return out.toByteArray();
        } finally {
            try { in.close(); } catch (Throwable ignored) { }
        }
    }

    private static void writeTo(InputStream in, File file) throws Exception {
        writeTo(readAll(in, MAX_BUNDLE_BYTES), file);
    }

    /** Written beside the target and renamed, so a half-written file is never
     *  the one that gets loaded. */
    private static void writeTo(byte[] data, File file) throws Exception {
        File temp = new File(file.getAbsolutePath() + ".writing");
        OutputStream out = new FileOutputStream(temp);
        try {
            out.write(data);
            out.flush();
        } finally {
            try { out.close(); } catch (Throwable ignored) { }
        }
        if (file.exists() && !file.delete()) throw new Exception("could not replace " + file);
        if (!temp.renameTo(file)) throw new Exception("could not put " + file + " in place");
    }

    private static void copy(File from, File to) throws Exception {
        writeTo(readAll(new java.io.FileInputStream(from), MAX_BUNDLE_BYTES), to);
    }

    private static void deleteQuietly(File file) {
        try { if (file.exists()) file.delete(); } catch (Throwable ignored) { }
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format(Locale.US, "%02x", b));
        return sb.toString();
    }

    /* A few values out of a small, known JSON reply. Pulling in a parser for
       four fields is not worth it, and this never sees anything but this
       server's own manifest. */

    private static String jsonString(String json, String field) {
        int at = json.indexOf("\"" + field + "\"");
        if (at < 0) return null;
        int colon = json.indexOf(':', at);
        int open = json.indexOf('"', colon + 1);
        if (colon < 0 || open < 0) return null;
        StringBuilder sb = new StringBuilder();
        for (int i = open + 1; i < json.length(); i++) {
            char c = json.charAt(i);
            if (c == '\\' && i + 1 < json.length()) { sb.append(json.charAt(++i)); continue; }
            if (c == '"') break;
            sb.append(c);
        }
        return sb.toString();
    }

    private static double jsonNumber(String json, String field) {
        int at = json.indexOf("\"" + field + "\"");
        if (at < 0) return -1;
        int colon = json.indexOf(':', at);
        if (colon < 0) return -1;
        int i = colon + 1;
        while (i < json.length() && Character.isWhitespace(json.charAt(i))) i++;
        int start = i;
        while (i < json.length() && (Character.isDigit(json.charAt(i)) || json.charAt(i) == '.' || json.charAt(i) == '-')) i++;
        try {
            return Double.parseDouble(json.substring(start, i));
        } catch (Throwable t) {
            return -1;
        }
    }

    private static boolean jsonBool(String json, String field) {
        int at = json.indexOf("\"" + field + "\"");
        if (at < 0) return false;
        int colon = json.indexOf(':', at);
        if (colon < 0) return false;
        return json.regionMatches(true, colon + 1, "true", 0, 4)
                || json.indexOf("true", colon) == colon + 1
                || json.substring(colon + 1, Math.min(json.length(), colon + 8)).trim().startsWith("true");
    }
}
