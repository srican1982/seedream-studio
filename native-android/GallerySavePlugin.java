package studio.seedream.agent;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.MimeTypeMap;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.Locale;

@CapacitorPlugin(name = "GallerySave")
public class GallerySavePlugin extends Plugin {

    @PluginMethod
    public void save(PluginCall call) {
        String source = call.getString("source");
        String filename = call.getString("filename", "seedream");
        String mime = call.getString("mime");
        boolean video = Boolean.TRUE.equals(call.getBoolean("video", false));

        if (source == null || source.trim().isEmpty()) {
            call.reject("Nothing to save.");
            return;
        }

        new Thread(() -> {
            HttpURLConnection connection = null;
            InputStream in = null;
            OutputStream out = null;
            Uri item = null;
            ContentResolver resolver = getContext().getContentResolver();
            try {
                String safeName = sanitize(filename);
                String resolvedMime = guessMime(safeName, mime, video);
                boolean isVideo = video || resolvedMime.startsWith("video/");

                ContentValues values = new ContentValues();
                values.put(MediaStore.MediaColumns.DISPLAY_NAME, safeName);
                values.put(MediaStore.MediaColumns.MIME_TYPE, resolvedMime);
                if (Build.VERSION.SDK_INT >= 29) {
                    String folder = isVideo ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES;
                    values.put(MediaStore.MediaColumns.RELATIVE_PATH, folder + "/Seedream Agent");
                    values.put(MediaStore.MediaColumns.IS_PENDING, 1);
                }

                Uri collection = isVideo
                    ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                    : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                item = resolver.insert(collection, values);
                if (item == null) {
                    throw new IllegalStateException("Android could not create a gallery item.");
                }

                if (source.startsWith("http://") || source.startsWith("https://")) {
                    connection = openHttp(source);
                    in = connection.getInputStream();
                } else {
                    in = openLocal(source);
                }

                out = resolver.openOutputStream(item);
                if (out == null) {
                    throw new IllegalStateException("Android could not open the gallery file.");
                }

                byte[] buffer = new byte[8192];
                int read;
                long total = 0;
                while ((read = in.read(buffer)) != -1) {
                    out.write(buffer, 0, read);
                    total += read;
                }
                out.flush();
                if (total == 0) {
                    throw new IllegalStateException("Downloaded file was empty. Generate again and save immediately.");
                }

                if (Build.VERSION.SDK_INT >= 29) {
                    ContentValues done = new ContentValues();
                    done.put(MediaStore.MediaColumns.IS_PENDING, 0);
                    resolver.update(item, done, null, null);
                }

                JSObject result = new JSObject();
                result.put("uri", item.toString());
                call.resolve(result);
            } catch (Exception error) {
                if (item != null) {
                    try {
                        resolver.delete(item, null, null);
                    } catch (Exception ignored) {
                        /* best effort */
                    }
                }
                call.reject("Could not save to gallery: " + error.getMessage());
            } finally {
                if (out != null) {
                    try {
                        out.close();
                    } catch (Exception ignored) {
                        /* ignore */
                    }
                }
                if (in != null) {
                    try {
                        in.close();
                    } catch (Exception ignored) {
                        /* ignore */
                    }
                }
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }).start();
    }

    private InputStream openLocal(String source) throws Exception {
        if (source.startsWith("data:")) {
            int comma = source.indexOf(',');
            if (comma < 0) {
                throw new IllegalArgumentException("Invalid data URL.");
            }
            byte[] bytes = Base64.decode(source.substring(comma + 1), Base64.DEFAULT);
            return new ByteArrayInputStream(bytes);
        }

        if (source.startsWith("content://")) {
            InputStream stream = getContext().getContentResolver().openInputStream(Uri.parse(source));
            if (stream == null) {
                throw new IllegalStateException("Could not read content URI.");
            }
            return stream;
        }

        String path = source.startsWith("file://") ? Uri.parse(source).getPath() : source;
        if (path == null || path.trim().isEmpty()) {
            throw new IllegalArgumentException("Invalid file path.");
        }
        return new FileInputStream(new File(path));
    }

    private HttpURLConnection openHttp(String source) throws Exception {
        URL url = new URL(source);
        HttpURLConnection connection = (HttpURLConnection) url.openConnection();
        connection.setConnectTimeout(30000);
        connection.setReadTimeout(300000);
        connection.setInstanceFollowRedirects(true);
        connection.setRequestProperty("User-Agent", "SeedreamStudio");
        int code = connection.getResponseCode();
        if (code >= 400) {
            throw new IllegalStateException(
                "Download failed (HTTP " + code + "). The file may have expired — generate again."
            );
        }
        return connection;
    }

    private String sanitize(String filename) {
        String name = filename.replaceAll("[^a-zA-Z0-9._-]", "_");
        if (name.trim().isEmpty()) {
            return "seedream-" + System.currentTimeMillis() + ".jpg";
        }
        return name;
    }

    private String guessMime(String filename, String mime, boolean video) {
        if (mime != null && !mime.trim().isEmpty() && !"application/octet-stream".equals(mime)) {
            return mime;
        }
        String lower = filename.toLowerCase(Locale.US);
        int dot = lower.lastIndexOf('.');
        String ext = dot >= 0 ? lower.substring(dot + 1) : "";
        String fromName = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        if (fromName != null && !fromName.trim().isEmpty()) {
            return fromName;
        }
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".gif")) return "image/gif";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".mp4")) return "video/mp4";
        if (lower.endsWith(".webm")) return "video/webm";
        if (lower.endsWith(".mov")) return "video/quicktime";
        return video ? "video/mp4" : "image/jpeg";
    }
}
