package studio.seedream.agent;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import org.json.JSONArray;
import org.json.JSONObject;

@CapacitorPlugin(
    name = "KeepAlive",
    permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class KeepAlivePlugin extends Plugin {
    private static volatile int refs = 0;
    private static volatile boolean active = false;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final Runnable keepWebView = new Runnable() {
        @Override
        public void run() {
            if (!active) return;
            resumeWebView();
            main.postDelayed(this, 8000);
        }
    };

    public static boolean isActive() {
        return active;
    }

    @PluginMethod
    public void start(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != com.getcapacitor.PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "onNotifications");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void onNotifications(PluginCall call) {
        begin(call);
    }

    private void begin(PluginCall call) {
        refs += 1;
        active = true;
        Intent intent = new Intent(getContext(), KeepAliveService.class);
        intent.putExtra(KeepAliveService.EXTRA_TITLE, call.getString("title", "AI Story"));
        intent.putExtra(
            KeepAliveService.EXTRA_TEXT,
            call.getString("text", "Generating… You can switch apps.")
        );
        try {
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
        } catch (Exception ignored) {
            /* Some OEMs block the notification; keep the WebView awake anyway. */
        }
        main.removeCallbacks(keepWebView);
        main.post(keepWebView);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        refs = Math.max(0, refs - 1);
        if (refs == 0) {
            active = false;
            main.removeCallbacks(keepWebView);
            getContext().stopService(new Intent(getContext(), KeepAliveService.class));
        }
        call.resolve();
    }

    @PluginMethod
    public void sleep(PluginCall call) {
        final int ms = Math.max(0, call.getInt("ms", 2000));
        new Thread(() -> {
            try {
                Thread.sleep(ms);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
            call.resolve();
        }, "ai-story-sleep").start();
    }

    @PluginMethod
    public void pollRunware(PluginCall call) {
        final String taskUUID = call.getString("taskUUID");
        final String apiKey = call.getString("apiKey");
        final int timeoutMs = call.getInt("timeoutMs", 15 * 60 * 1000);
        if (taskUUID == null || taskUUID.trim().isEmpty() || apiKey == null || apiKey.trim().isEmpty()) {
            call.reject("Missing Runware task.");
            return;
        }
        new Thread(() -> {
            try {
                call.resolve(waitForTask(taskUUID, apiKey, timeoutMs));
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "Generation failed.");
            }
        }, "ai-story-poll").start();
    }

    private void resumeWebView() {
        main.post(() -> {
            if (getBridge() == null) return;
            WebView webView = getBridge().getWebView();
            if (webView == null) return;
            webView.onResume();
            webView.resumeTimers();
        });
    }

    private JSObject waitForTask(String taskUUID, String apiKey, int timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + Math.max(30_000, timeoutMs);
        long delay = 2000;
        while (System.currentTimeMillis() < deadline) {
            Thread.sleep(delay);
            JSONObject payload = postRunware(apiKey, getResponseBody(taskUUID));
            JSONArray errors = payload.optJSONArray("errors");
            if (errors != null && errors.length() > 0) {
                JSONObject first = errors.optJSONObject(0);
                String message = first != null ? first.optString("message", "") : "";
                throw new IllegalStateException(message.isEmpty() ? "Runware request failed" : message);
            }
            JSONArray rows = payload.optJSONArray("data");
            if (rows == null) continue;
            JSONObject failed = findRow(rows, "error");
            if (failed != null) {
                String message = "";
                JSONObject err = failed.optJSONObject("error");
                if (err != null) {
                    message = err.optString("message", "");
                    if (message.isEmpty()) message = err.toString();
                } else {
                    message = failed.optString("error", "");
                    if (message.isEmpty()) message = failed.optString("message", "");
                }
                throw new IllegalStateException(message.isEmpty() ? "Generation failed." : message);
            }
            JSONObject done = findFinished(rows);
            if (done != null) {
                return finish(done, rows);
            }
            delay = Math.min(Math.round(delay * 1.25f), 8000);
        }
        throw new IllegalStateException("Timed out waiting for Runware.");
    }

    private JSObject finish(JSONObject row, JSONArray rows) throws Exception {
        JSObject result = new JSObject();
        result.put("row", new JSObject(row.toString()));
        JSArray wipeIds = new JSArray();
        for (String id : collectWipeIds(rows)) {
            wipeIds.put(id);
        }
        result.put("wipeIds", wipeIds);
        String mediaUrl = firstUrl(row);
        if (mediaUrl != null) {
            try {
                File file = downloadToCache(mediaUrl, row.has("videoURL"));
                result.put("localPath", file.getAbsolutePath());
            } catch (Exception ignored) {
                /* JS persistNativeResult can still try */
            }
        }
        return result;
    }

    private static JSONArray getResponseBody(String taskUUID) {
        JSONArray tasks = new JSONArray();
        JSONObject task = new JSONObject();
        try {
            task.put("taskType", "getResponse");
            task.put("taskUUID", taskUUID);
            tasks.put(task);
        } catch (Exception ignored) {
            /* constructed locally */
        }
        return tasks;
    }

    private static JSONObject postRunware(String apiKey, JSONArray tasks) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL("https://api.runware.ai/v1").openConnection();
        connection.setRequestMethod("POST");
        connection.setConnectTimeout(60000);
        connection.setReadTimeout(120000);
        connection.setDoOutput(true);
        connection.setRequestProperty("Authorization", "Bearer " + apiKey);
        connection.setRequestProperty("Content-Type", "application/json");
        byte[] body = tasks.toString().getBytes(StandardCharsets.UTF_8);
        connection.setFixedLengthStreamingMode(body.length);
        try (OutputStream out = connection.getOutputStream()) {
            out.write(body);
        }
        int code = connection.getResponseCode();
        InputStream stream = code >= 400 ? connection.getErrorStream() : connection.getInputStream();
        String text = readAll(stream);
        connection.disconnect();
        if (text == null || text.trim().isEmpty()) {
            throw new IllegalStateException("Empty Runware response.");
        }
        return new JSONObject(text);
    }

    private File downloadToCache(String fileUrl, boolean video) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(fileUrl).openConnection();
        connection.setConnectTimeout(60000);
        connection.setReadTimeout(600000);
        connection.setInstanceFollowRedirects(true);
        int code = connection.getResponseCode();
        if (code >= 400) {
            connection.disconnect();
            throw new IllegalStateException("Download failed (HTTP " + code + ").");
        }
        String ext = extensionFor(fileUrl, video);
        File out = new File(getContext().getCacheDir(), "ai-story-" + System.currentTimeMillis() + ext);
        try (InputStream in = connection.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
            byte[] buffer = new byte[8192];
            int read;
            long total = 0;
            while ((read = in.read(buffer)) != -1) {
                fos.write(buffer, 0, read);
                total += read;
            }
            if (total == 0) throw new IllegalStateException("Downloaded file was empty.");
        } finally {
            connection.disconnect();
        }
        return out;
    }

    private static String extensionFor(String fileUrl, boolean video) {
        String lower = fileUrl.toLowerCase();
        if (lower.contains(".png")) return ".png";
        if (lower.contains(".webp")) return ".webp";
        if (lower.contains(".webm")) return ".webm";
        if (lower.contains(".mov")) return ".mov";
        if (lower.contains(".mp4")) return ".mp4";
        if (lower.contains(".jpg") || lower.contains(".jpeg")) return ".jpg";
        return video ? ".mp4" : ".jpg";
    }

    private static JSONObject findRow(JSONArray rows, String status) {
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row != null && status.equals(row.optString("status"))) return row;
        }
        return null;
    }

    private static JSONObject findFinished(JSONArray rows) {
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (isFinished(row)) return row;
        }
        return null;
    }

    private static boolean isFinished(JSONObject row) {
        if (row == null) return false;
        return "success".equals(row.optString("status"))
            || row.has("imageURL")
            || row.has("imageDataURI")
            || row.has("imageBase64Data")
            || row.has("videoURL");
    }

    private static String firstUrl(JSONObject row) {
        if (row == null) return null;
        String image = row.optString("imageURL", "");
        if (image.startsWith("http")) return image;
        String video = row.optString("videoURL", "");
        if (video.startsWith("http")) return video;
        return null;
    }

    private static java.util.List<String> collectWipeIds(JSONArray rows) {
        java.util.LinkedHashSet<String> ids = new java.util.LinkedHashSet<>();
        for (int i = 0; i < rows.length(); i++) {
            JSONObject row = rows.optJSONObject(i);
            if (row == null) continue;
            addId(ids, row.optString("imageUUID", ""));
            addId(ids, row.optString("videoUUID", ""));
            addId(ids, row.optString("mediaUUID", ""));
            addId(ids, uuidFromUrl(row.optString("imageURL", "")));
            addId(ids, uuidFromUrl(row.optString("videoURL", "")));
        }
        return new java.util.ArrayList<>(ids);
    }

    private static void addId(java.util.Set<String> ids, String value) {
        if (value != null && !value.trim().isEmpty()) ids.add(value);
    }

    private static String uuidFromUrl(String url) {
        java.util.regex.Matcher match = java.util.regex.Pattern
            .compile("([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})", java.util.regex.Pattern.CASE_INSENSITIVE)
            .matcher(url == null ? "" : url);
        return match.find() ? match.group(1) : "";
    }

    private static String readAll(InputStream stream) throws Exception {
        if (stream == null) return "";
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int read;
        while ((read = stream.read(buffer)) != -1) {
            out.write(buffer, 0, read);
        }
        stream.close();
        return out.toString(StandardCharsets.UTF_8.name());
    }
}
