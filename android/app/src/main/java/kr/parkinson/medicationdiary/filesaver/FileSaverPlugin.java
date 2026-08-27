package kr.parkinson.medicationdiary.filesaver;

import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.util.Base64;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.IOException;
import java.io.OutputStream;

/**
 * 백업 JSON / PDF를 공용 Downloads 컬렉션에 저장한다 (Android 10+/scoped storage,
 * MANAGE_EXTERNAL_STORAGE 미사용, 추가 런타임 권한 불필요).
 *
 * 예전 TWA 시절 코드(www/index.html의 saveFileSafely)는 Web Share API가 안 되면
 * <a download> 가짜 클릭으로 대체했는데, 이 경로는 실제 파일 생성 여부를 JS가
 * 확인할 방법이 없어 "저장을 요청했다"고만 말할 수 있었다. 이 플러그인은 MediaStore에
 * 직접 쓰고 바이트 수까지 검증한 뒤에만 성공을 보고한다 — 실패하면 반드시 status:"error".
 */
@CapacitorPlugin(name = "FileSaver")
public class FileSaverPlugin extends Plugin {

    @PluginMethod
    public void saveToDownloads(PluginCall call) {
        String filename = call.getString("filename");
        String mimeType = call.getString("mimeType", "application/octet-stream");
        String base64Data = call.getString("data");

        if (filename == null || filename.trim().isEmpty() || base64Data == null) {
            resolveError(call, "filename/data missing");
            return;
        }

        byte[] bytes;
        try {
            bytes = Base64.decode(base64Data, Base64.DEFAULT);
        } catch (Exception e) {
            resolveError(call, "base64 decode failed");
            return;
        }

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            /* API 24-28(스코프 스토리지 이전)은 이번 범위에서 다루지 않는다 — 호출한 쪽
               (www/index.html)이 기존 Web Share/다운로드 경로로 대체 시도한다. */
            resolveError(call, "unsupported_api_level");
            return;
        }

        Context context = getContext();
        ContentResolver resolver = context.getContentResolver();
        String finalName = resolveUniqueName(resolver, filename);

        ContentValues values = new ContentValues();
        values.put(MediaStore.Downloads.DISPLAY_NAME, finalName);
        values.put(MediaStore.Downloads.MIME_TYPE, mimeType);
        values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
        values.put(MediaStore.Downloads.IS_PENDING, 1);

        Uri itemUri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (itemUri == null) {
            resolveError(call, "insert failed");
            return;
        }

        boolean success;
        try (OutputStream out = resolver.openOutputStream(itemUri)) {
            if (out == null) throw new IOException("openOutputStream returned null");
            out.write(bytes);
            out.flush();
            success = true;
        } catch (Exception e) {
            success = false;
        }

        if (success) {
            success = verifySize(resolver, itemUri, bytes.length);
        }

        if (!success) {
            try {
                resolver.delete(itemUri, null, null);
            } catch (Exception ignored) {}
            resolveError(call, "write verification failed");
            return;
        }

        ContentValues done = new ContentValues();
        done.put(MediaStore.Downloads.IS_PENDING, 0);
        resolver.update(itemUri, done, null, null);

        JSObject result = new JSObject();
        result.put("status", "success");
        result.put("fileName", finalName);
        result.put("location", "Download");
        call.resolve(result);
    }

    private void resolveError(PluginCall call, String message) {
        JSObject err = new JSObject();
        err.put("status", "error");
        err.put("message", message);
        call.resolve(err);
    }

    private boolean verifySize(ContentResolver resolver, Uri uri, long expected) {
        try (ParcelFileDescriptor pfd = resolver.openFileDescriptor(uri, "r")) {
            return pfd != null && pfd.getStatSize() == expected;
        } catch (Exception e) {
            return false;
        }
    }

    /** 같은 이름이 Downloads에 이미 있으면 "_2", "_3" ... 로 안전하게 이름을 바꾼다. */
    private String resolveUniqueName(ContentResolver resolver, String filename) {
        String base = filename;
        String ext = "";
        int dot = filename.lastIndexOf('.');
        if (dot > 0) {
            base = filename.substring(0, dot);
            ext = filename.substring(dot);
        }
        String candidate = filename;
        int n = 1;
        while (existsInDownloads(resolver, candidate) && n < 999) {
            n++;
            candidate = base + "_" + n + ext;
        }
        return candidate;
    }

    private boolean existsInDownloads(ContentResolver resolver, String displayName) {
        String[] projection = { MediaStore.Downloads._ID };
        String selection = MediaStore.Downloads.DISPLAY_NAME + "=?";
        String[] args = { displayName };
        try (Cursor cursor = resolver.query(MediaStore.Downloads.EXTERNAL_CONTENT_URI, projection, selection, args, null)) {
            return cursor != null && cursor.getCount() > 0;
        } catch (Exception e) {
            return false;
        }
    }
}
