package com.surveyor.app;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;

import java.io.File;
import java.io.FileNotFoundException;

/**
 * Minimal ContentProvider (plain android.content, NO androidx FileProvider)
 * that serves EXACTLY ONE file — getFilesDir()/update.apk — to the system
 * package installer during a self-update.
 *
 * Manifest: authority "com.surveyor.app.updates", exported=false,
 * grantUriPermissions=true. The installer only gets access because the
 * ACTION_VIEW intent carries FLAG_GRANT_READ_URI_PERMISSION; nothing else can
 * open it, and any URI other than content://com.surveyor.app.updates/update.apk
 * is rejected.
 */
public class ApkProvider extends ContentProvider {

    static final String AUTHORITY = "com.surveyor.app.updates";
    static final String APK_NAME = "update.apk";
    static final Uri CONTENT_URI = Uri.parse("content://" + AUTHORITY + "/" + APK_NAME);

    private static final String APK_MIME = "application/vnd.android.package-archive";

    @Override
    public boolean onCreate() {
        return true;
    }

    /** Serve only /update.apk, read-only; reject any other path or mode. */
    @Override
    public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!isOurUri(uri)) {
            throw new FileNotFoundException("Unsupported URI: " + uri);
        }
        if (mode == null || !mode.equals("r")) {
            throw new FileNotFoundException("Read-only provider");
        }
        File apk = apkFile();
        if (apk == null || !apk.isFile()) {
            throw new FileNotFoundException("No update APK available");
        }
        return ParcelFileDescriptor.open(apk, ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override
    public String getType(Uri uri) {
        return isOurUri(uri) ? APK_MIME : null;
    }

    /** The package installer queries DISPLAY_NAME/SIZE; answer just those. */
    @Override
    public Cursor query(Uri uri, String[] projection, String selection,
                        String[] selectionArgs, String sortOrder) {
        if (!isOurUri(uri)) {
            return null;
        }
        File apk = apkFile();
        if (apk == null || !apk.isFile()) {
            return null;
        }
        if (projection == null) {
            projection = new String[] { OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE };
        }
        MatrixCursor cursor = new MatrixCursor(projection, 1);
        Object[] row = new Object[projection.length];
        for (int i = 0; i < projection.length; i++) {
            if (OpenableColumns.DISPLAY_NAME.equals(projection[i])) {
                row[i] = APK_NAME;
            } else if (OpenableColumns.SIZE.equals(projection[i])) {
                row[i] = apk.length();
            } else {
                row[i] = null;
            }
        }
        cursor.addRow(row);
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        return null; // read-only
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        return 0; // read-only
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        return 0; // read-only
    }

    // ------------------------------------------------------------ internals

    private static boolean isOurUri(Uri uri) {
        return uri != null
                && AUTHORITY.equals(uri.getAuthority())
                && ("/" + APK_NAME).equals(uri.getPath());
    }

    private File apkFile() {
        return getContext() == null ? null : new File(getContext().getFilesDir(), APK_NAME);
    }
}
