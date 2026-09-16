import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const native = path.join(root, "native-android");
const androidRoot = path.join(root, "android");
const androidApp = path.join(androidRoot, "app", "src", "main");
const javaDir = path.join(androidApp, "java", "studio", "seedream", "agent");
const manifestPath = path.join(androidApp, "AndroidManifest.xml");
const stylesPath = path.join(androidApp, "res", "values", "styles.xml");
const stylesV35Dir = path.join(androidApp, "res", "values-v35");
const gradlePath = path.join(androidRoot, "app", "build.gradle");

const permissions = [
  '    <uses-permission android:name="android.permission.INTERNET" />',
  '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="28" />',
  '    <uses-permission android:name="android.permission.WAKE_LOCK" />',
  '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE" />',
  '    <uses-permission android:name="android.permission.FOREGROUND_SERVICE_DATA_SYNC" />',
  '    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />',
];

await mkdir(javaDir, { recursive: true });
await copyFile(path.join(native, "GallerySavePlugin.java"), path.join(javaDir, "GallerySavePlugin.java"));
await copyFile(path.join(native, "KeepAlivePlugin.java"), path.join(javaDir, "KeepAlivePlugin.java"));
await copyFile(path.join(native, "KeepAliveService.java"), path.join(javaDir, "KeepAliveService.java"));
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
}
if (xml.includes("android:windowSoftInputMode")) {
  xml = xml.replace(/android:windowSoftInputMode="[^"]*"/, 'android:windowSoftInputMode="adjustResize"');
} else {
  xml = xml.replace(/<activity\b/, '<activity android:windowSoftInputMode="adjustResize"');
}
if (xml.includes("android:allowBackup")) {
  xml = xml.replace(/android:allowBackup="[^"]*"/, 'android:allowBackup="false"');
} else {
  xml = xml.replace(/<application\b/, '<application android:allowBackup="false"');
}
if (!xml.includes("KeepAliveService")) {
  xml = xml.replace(
    "</application>",
    `        <service
            android:name="studio.seedream.agent.KeepAliveService"
            android:exported="false"
            android:foregroundServiceType="dataSync" />
    </application>`
  );
}
await writeFile(manifestPath, xml);
if (missing.length) console.log(`Added ${missing.length} Android permissions`);

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
  const from = path.join(native, `mipmap-${density}`);
  const dir = path.join(androidApp, "res", `mipmap-${density}`);
  await mkdir(dir, { recursive: true });
  for (const name of ["ic_launcher.png", "ic_launcher_round.png", "ic_launcher_foreground.png"]) {
    await copyFile(path.join(from, name), path.join(dir, name));
  }
}

const anyDpi = path.join(androidApp, "res", "mipmap-anydpi-v26");
await rm(anyDpi, { recursive: true, force: true });
await rm(path.join(androidApp, "res", "drawable-v24", "ic_launcher_foreground.xml"), { force: true });
await rm(path.join(androidApp, "res", "drawable", "ic_launcher_foreground.xml"), { force: true });

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

console.log("Patched Android gallery saver, keep-alive service, MainActivity, icons, and nav-bar styles");
