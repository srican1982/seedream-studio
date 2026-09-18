package studio.seedream.agent;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.webkit.MimeTypeMap;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@CapacitorPlugin(name = "GalleryPick")
public class GalleryPickPlugin extends Plugin {

    @PluginMethod
    public void pick(PluginCall call) {
        int limit = Math.max(1, call.getInt("limit", 16));
        startActivityForResult(call, buildIntent(limit), "onPicked");
    }

    private Intent buildIntent(int limit) {
        int max = Math.max(2, Math.min(limit, 50));
        if (Build.VERSION.SDK_INT >= 34) {
            Intent intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
            intent.putExtra(MediaStore.EXTRA_PICK_IMAGES_MAX, max);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "image/*", "video/*" });
            return intent;
        }
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "image/*", "video/*", "audio/*" });
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        return intent;
    }

    @ActivityCallback
    private void onPicked(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.resolve(empty());
            return;
        }
        List<Uri> uris = collectUris(result.getData());
        if (uris.isEmpty()) {
            call.resolve(empty());
            return;
        }
        int limit = Math.max(1, call.getInt("limit", 16));
        new Thread(() -> {
            try {
                JSArray files = new JSArray();
                int count = 0;
                for (Uri uri : uris) {
                    if (count >= limit) break;
                    JSObject row = copyUri(uri);
                    if (row != null) {
                        files.put(row);
                        count += 1;
                    }
                }
                JSObject out = new JSObject();
                out.put("files", files);
                call.resolve(out);
            } catch (Exception error) {
                call.reject(error.getMessage() != null ? error.getMessage() : "Could not read those files.");
            }
        }).start();
    }

    private JSObject empty() {
        JSObject out = new JSObject();
        out.put("files", new JSArray());
        return out;
    }

    private List<Uri> collectUris(Intent data) {
        List<Uri> uris = new ArrayList<>();
        if (data == null) return uris;
        ClipData clip = data.getClipData();
        if (clip != null) {
            for (int i = 0; i < clip.getItemCount(); i++) {
                Uri uri = clip.getItemAt(i).getUri();
                if (uri != null) uris.add(uri);
            }
            return uris;
        }
        if (data.getData() != null) uris.add(data.getData());
        return uris;
    }

    private JSObject copyUri(Uri uri) {
        ContentResolver resolver = getContext().getContentResolver();
        String mime = resolver.getType(uri);
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        String name = displayName(uri, mime);
        File dir = new File(getContext().getCacheDir(), "picks");
        if (!dir.exists() && !dir.mkdirs()) return null;
        File dest = new File(dir, System.currentTimeMillis() + "-" + sanitize(name));
        try (InputStream in = resolver.openInputStream(uri); FileOutputStream out = new FileOutputStream(dest)) {
            if (in == null) return null;
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
            }
            out.flush();
        } catch (Exception error) {
            return null;
        }
        if (!dest.isFile() || dest.length() == 0) return null;
        String kind = mime.startsWith("video/") ? "video" : mime.startsWith("audio/") ? "audio" : "image";
        JSObject row = new JSObject();
        row.put("path", Uri.fromFile(dest).toString());
        row.put("name", name);
        row.put("mime", mime);
        row.put("kind", kind);
        return row;
    }

    private String displayName(Uri uri, String mime) {
        String name = "";
        try (Cursor cursor = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int idx = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (idx >= 0) {
                    String value = cursor.getString(idx);
                    if (value != null) name = value;
                }
            }
        } catch (Exception ignored) {
            /* use fallback */
        }
        if (name.trim().isEmpty()) {
            String ext = MimeTypeMap.getSingleton().getExtensionFromMimeType(mime);
            name = "media-" + System.currentTimeMillis() + (ext != null && !ext.isEmpty() ? "." + ext : "");
        }
        return name;
    }

    private String sanitize(String filename) {
        String name = filename.replaceAll("[^a-zA-Z0-9._-]", "_");
        if (name.trim().isEmpty()) {
            return "media-" + System.currentTimeMillis();
        }
        return name.toLowerCase(Locale.US);
    }
}
