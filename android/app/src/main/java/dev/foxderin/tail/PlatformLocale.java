package dev.foxderin.tail;

import android.content.Context;
import android.content.res.Configuration;
import java.util.Locale;

final class PlatformLocale {
    static Context localized(Context base) {
        String language = base.getSharedPreferences("interface", Context.MODE_PRIVATE).getString("language", "auto");
        if ("auto".equals(language)) return base;
        Configuration config = new Configuration(base.getResources().getConfiguration());
        config.setLocale(Locale.forLanguageTag(language));
        return base.createConfigurationContext(config);
    }
}
