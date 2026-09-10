import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const native = path.join(root, "native-android");
const androidApp = path.join(root, "android", "app", "src", "main");
const javaDir = path.join(androidApp, "java", "studio", "seedream", "agent");
const manifestPath = path.join(androidApp, "AndroidManifest.xml");
const stylesPath = path.join(androidApp, "res", "values", "styles.xml");
const stylesV35Dir = path.join(androidApp, "res", "values-v35");

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

console.log("Patched Android gallery saver, MainActivity, and nav-bar styles");
