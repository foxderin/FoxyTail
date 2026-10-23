package dev.foxderin.tail;

import org.json.*;
import java.io.IOException;
import java.util.*;

final class FilesBrowser {
    static final class Entry {
        final String name, path; final boolean directory; final long size, mtime;
        Entry(JSONObject item, String parent) throws Exception {
            name = Models.required(item, "name"); Models.requireName(name);
            path = Models.required(item, "path");
            if (!Models.sharedPath(path) || !path.equals("/sdcard/" + (parent.isEmpty() ? "" : parent + "/") + name) || !(item.get("directory") instanceof Boolean)) throw new IOException("Invalid browse entry");
            directory = item.getBoolean("directory"); size = Models.number(item, "size"); mtime = Models.number(item, "mtime");
        }
    }
    static List<Entry> parse(JSONObject result, String requested) throws Exception {
        if (!Models.relativePath(requested) || !result.getBoolean("ok") || !requested.equals(result.get("path")) || !(result.get("truncated") instanceof Boolean)) throw new IOException("Invalid browse response");
        JSONArray entries = result.getJSONArray("entries");
        if (entries.length() > 1000) throw new IOException("Invalid browse count");
        ArrayList<Entry> parsed = new ArrayList<>(); Set<String> paths = new HashSet<>();
        for (int i = 0; i < entries.length(); i++) {
            Entry entry = new Entry(entries.getJSONObject(i), requested);
            if (!paths.add(entry.path)) throw new IOException("Duplicate browse entry");
            parsed.add(entry);
        }
        return parsed;
    }
}
