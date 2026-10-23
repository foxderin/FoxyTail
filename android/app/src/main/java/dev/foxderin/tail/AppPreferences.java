package dev.foxderin.tail;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import org.json.JSONObject;
import java.util.Locale;

final class AppPreferences {
    private AppPreferences() { }

    static Context localized(Context base) {
        String language = base.getSharedPreferences("interface", Context.MODE_PRIVATE).getString("language", "auto");
        Configuration configuration = new Configuration(base.getResources().getConfiguration());
        if ("auto".equals(language)) configuration.setLocales(android.content.res.Resources.getSystem().getConfiguration().getLocales());
        else configuration.setLocale(Locale.forLanguageTag(language));
        return base.createConfigurationContext(configuration);
    }

    static JSONObject appearance(Context context) {
        SharedPreferences prefs = context.getSharedPreferences("interface", Context.MODE_PRIVATE);
        return WebBridge.object("theme", prefs.getString("theme", "auto"), "language", prefs.getString("language", "auto"));
    }

    static JSONObject update(Context context, JSONObject args) throws Exception {
        WebBridge.keys(args, "theme", "language");
        SharedPreferences.Editor editor = context.getSharedPreferences("interface", Context.MODE_PRIVATE).edit();
        if (args.has("theme")) editor.putString("theme", WebBridge.choice(WebBridge.text(args, "theme", 8), "auto", "light", "dark"));
        if (args.has("language")) editor.putString("language", WebBridge.choice(WebBridge.text(args, "language", 8), "auto", "en", "zh"));
        if (!editor.commit()) throw new java.io.IOException("Could not save appearance");
        return appearance(context);
    }
}
