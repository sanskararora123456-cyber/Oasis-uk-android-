package com.oasis.uksteeldoor;

import android.Manifest;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.print.PrintAttributes;
import android.print.PrintManager;
import android.provider.MediaStore;
import android.webkit.DownloadListener;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import android.view.Window;
import android.widget.Toast;
import androidx.core.content.FileProvider;
import java.io.File;

public class MainActivity extends Activity {
    private WebView webView;
    private final Map<String, String> memoryStore = new ConcurrentHashMap<>();
    private ValueCallback<Uri[]> fileCallback;
    private static final int FILE_PICKER = 9001;
    private static final int CAMERA_CAPTURE = 9002;
    private Uri cameraUri;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        requestWindowFeature(Window.FEATURE_NO_TITLE);
        // V8.5 secure mode: business data is memory-only on the Android client.
        // No SQLite/localStorage business database is exposed through the native bridge.
        webView = new WebView(this);
        setContentView(webView);
        configureWebView();
        webView.loadUrl("file:///android_asset/index.html");
    }

    private void configureWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true); s.setDatabaseEnabled(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowFileAccess(true); s.setAllowContentAccess(true);
        s.setBuiltInZoomControls(false); s.setDisplayZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(false); s.setSupportMultipleWindows(false);
        s.setUserAgentString(s.getUserAgentString() + " OasisUK-Android/2.0");
        webView.addJavascriptInterface(new OasisBridge(), "OasisAndroid");

        webView.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                return handleUrl(req.getUrl());
            }
            @Override public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                view.evaluateJavascript("window.print=function(){if(window.OasisAndroid){window.OasisAndroid.print();}};", null);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> cb, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = cb;
                if (params.isCaptureEnabled()) {
                    launchCamera();
                    return true;
                }
                Intent i = params.createIntent(); i.addCategory(Intent.CATEGORY_OPENABLE);
                try { startActivityForResult(i, FILE_PICKER); }
                catch (ActivityNotFoundException e) { fileCallback=null; cb.onReceiveValue(null); Toast.makeText(MainActivity.this,"No file picker available",Toast.LENGTH_SHORT).show(); }
                return true;
            }
        });

        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            try {
                DownloadManager.Request r = new DownloadManager.Request(Uri.parse(url));
                r.setMimeType(mimeType); r.addRequestHeader("User-Agent", userAgent);
                r.setTitle("Oasis UK document"); r.setDescription("Downloading document");
                r.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                r.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, "Oasis-" + System.currentTimeMillis());
                ((DownloadManager)getSystemService(DOWNLOAD_SERVICE)).enqueue(r);
                Toast.makeText(this,"Download started",Toast.LENGTH_SHORT).show();
            } catch (Exception e) { Toast.makeText(this,"Download failed",Toast.LENGTH_SHORT).show(); }
        });
    }

    private boolean handleUrl(Uri u) {
        String scheme = u.getScheme()==null?"":u.getScheme().toLowerCase();
        if (scheme.equals("http") || scheme.equals("https") || scheme.equals("mailto") || scheme.equals("tel") || scheme.equals("whatsapp")) {
            try { startActivity(new Intent(Intent.ACTION_VIEW,u)); } catch (ActivityNotFoundException ignored) {}
            return true;
        }
        return false;
    }

    private void launchCamera() {
        if (android.os.Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, CAMERA_CAPTURE); return;
        }
        try {
            File f = new File(getExternalFilesDir(Environment.DIRECTORY_PICTURES), "Oasis_"+System.currentTimeMillis()+".jpg");
            cameraUri = FileProvider.getUriForFile(this, getPackageName()+".fileprovider", f);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE); i.putExtra(MediaStore.EXTRA_OUTPUT,cameraUri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, CAMERA_CAPTURE);
        } catch (Exception e) { if(fileCallback!=null){fileCallback.onReceiveValue(null);fileCallback=null;} Toast.makeText(this,"Camera unavailable",Toast.LENGTH_SHORT).show(); }
    }

    public void printCurrentPage() {
        PrintManager pm=(PrintManager)getSystemService(PRINT_SERVICE);
        pm.print("Oasis UK Document",webView.createPrintDocumentAdapter("Oasis UK"),new PrintAttributes.Builder().build());
    }

    @Override public void onRequestPermissionsResult(int requestCode,String[] permissions,int[] grantResults){
        super.onRequestPermissionsResult(requestCode,permissions,grantResults);
        if(requestCode==CAMERA_CAPTURE){ if(grantResults.length>0&&grantResults[0]==PackageManager.PERMISSION_GRANTED) launchCamera(); else if(fileCallback!=null){fileCallback.onReceiveValue(null);fileCallback=null;} }
    }

    @Override protected void onActivityResult(int requestCode,int resultCode,Intent data){
        super.onActivityResult(requestCode,resultCode,data);
        if(requestCode==FILE_PICKER&&fileCallback!=null){ Uri[] r=WebChromeClient.FileChooserParams.parseResult(resultCode,data); fileCallback.onReceiveValue(r); fileCallback=null; }
        else if(requestCode==CAMERA_CAPTURE&&fileCallback!=null){ Uri[] r=(resultCode==RESULT_OK&&cameraUri!=null)?new Uri[]{cameraUri}:null; fileCallback.onReceiveValue(r); fileCallback=null; }
    }

    public class OasisBridge {
        @JavascriptInterface public String getItem(String key){return memoryStore.get(key);}
        @JavascriptInterface public boolean setItem(String key,String value){if(key==null)return false; memoryStore.put(key, value==null?"":value); return true;}
        @JavascriptInterface public boolean removeItem(String key){if(key==null)return false; memoryStore.remove(key); return true;}
        @JavascriptInterface public void clear(){memoryStore.clear();}
        @JavascriptInterface public void print(){runOnUiThread(()->printCurrentPage());}
        @JavascriptInterface public String appVersion(){return "8.5.0-secure";}
    }

    @Override public void onBackPressed(){ if(webView.canGoBack()) webView.goBack(); else super.onBackPressed(); }
    @Override protected void onDestroy(){ if(webView!=null) webView.destroy(); super.onDestroy(); }
}
