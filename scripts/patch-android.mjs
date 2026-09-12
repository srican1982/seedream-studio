import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const native = path.join(root, "native-android");
const androidRoot = path.join(root, "android");
const androidApp = path.join(androidRoot, "app", "src", "main");
const javaDir = path.join(androidApp, "java", "studio", "seedream", "agent");
const manifestPath = path.join(androidApp, "AndroidManifest.xml");
const stylesPath = path.join(androidApp, "res", "values", "styles.xml");
const stylesV35Dir = path.join(androidApp, "res", "values-v35");
const colorsPath = path.join(androidApp, "res", "values", "ic_launcher_background.xml");
const gradlePath = path.join(androidRoot, "app", "build.gradle");
const icon = path.join(native, "ic_launcher.png");

const permissions = [
  '    <uses-permission android:name="android.permission.INTERNET" />',
  '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',
];

await mkdir(javaDir, { recursive: true });
await copyFile(path.join(native, "GallerySavePlugin.java"), path.join(javaDir, "GallerySavePlugin.java"));
await copyFile(path.join(native, "MainActivity.java"), path.join(javaDir, "MainActivity.java"));

await mkdir(stylesV35Dir, { recursive: true });
await copyFile(path.join(native, "values-v35-styles.xml"), path.join(stylesV35Dir, "styles.xml"));

let xml = await readFile(manifestPath, "utf8");
const missing = permissions.filter((line) => {
  const name = /android:name="([^"]+)"/.exec(line)?.[1];
  return name ? !xml.includes(`android:name="${name}"`) : false;
});
if (missing.length) {
  xml = xml.replace(/<manifest\b[^>]*>/, (open) => `${open}\n${missing.join("\n")}`);
  await writeFile(manifestPath, xml);
  console.log(`Added ${missing.length} Android permissions`);
}

try {
  let styles = await readFile(stylesPath, "utf8");
  if (!styles.includes("android:navigationBarColor")) {
    styles = styles.replace(
      /<style name="AppTheme\.NoActionBar"[^>]*>/,
      (open) =>
        `${open}\n        <item name="android:navigationBarColor">#0b0c10</item>\n        <item name="android:statusBarColor">#0b0c10</item>`
    );
    await writeFile(stylesPath, styles);
  }
} catch {
  console.log("Could not patch values/styles.xml");
}

for (const density of ["mdpi", "hdpi", "xhdpi", "xxhdpi", "xxxhdpi"]) {
  const dir = path.join(androidApp, "res", `mipmap-${density}`);
  await mkdir(dir, { recursive: true });
  await copyFile(icon, path.join(dir, "ic_launcher.png"));
  await copyFile(icon, path.join(dir, "ic_launcher_round.png"));
  await copyFile(icon, path.join(dir, "ic_launcher_foreground.png"));
}

const anyDpi = path.join(androidApp, "res", "mipmap-anydpi-v26");
await mkdir(anyDpi, { recursive: true });
await mkdir(path.join(androidApp, "res", "values"), { recursive: true });
await writeFile(
  colorsPath,
  `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">#0B0C10</color>
</resources>
`
);
const adaptive = `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
`;
await writeFile(path.join(anyDpi, "ic_launcher.xml"), adaptive);
await writeFile(path.join(anyDpi, "ic_launcher_round.xml"), adaptive);

const keystoreSrc = path.join(native, "ai-story.keystore");
const keystoreDest = path.join(androidRoot, "app", "ai-story.keystore");
await copyFile(keystoreSrc, keystoreDest);

let gradle = await readFile(gradlePath, "utf8");
if (!gradle.includes("ai-story.keystore")) {
  gradle = gradle.replace(
    /buildTypes\s*\{/,
    `signingConfigs {
        release {
            storeFile file("ai-story.keystore")
            storePassword "AIstory-2026-release"
            keyAlias "aistory"
            keyPassword "AIstory-2026-release"
        }
    }
    buildTypes {`
  );
  gradle = gradle.replace(
    /buildTypes \{\s*release \{/,
    `buildTypes {
        release {
            signingConfig signingConfigs.release`
  );
  await writeFile(gradlePath, gradle);
  console.log("Added release signing config");
}

console.log("Patched Android gallery saver, MainActivity, icons, and nav-bar styles");
