import { readFile, writeFile } from "node:fs/promises";

const manifestPath = "android/app/src/main/AndroidManifest.xml";
const permissions = [
  '    <uses-permission android:name="android.permission.INTERNET" />',
  '    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />',
  '    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />',
  '    <uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED" />',
  '    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />',
  '    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
];

let xml = await readFile(manifestPath, "utf8");
const missing = permissions.filter((line) => {
  const name = /android:name="([^"]+)"/.exec(line)?.[1];
  return name ? !xml.includes(`android:name="${name}"`) : false;
});

if (missing.length) {
  xml = xml.replace(/<manifest\b[^>]*>/, (open) => `${open}\n${missing.join("\n")}`);
  await writeFile(manifestPath, xml);
  console.log(`Added ${missing.length} Android gallery permissions`);
} else {
  console.log("Android gallery permissions already present");
}
