import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "studio.seedream.app",
  appName: "Seedream Studio",
  webDir: "dist",
  server: {
    androidScheme: "https",
  },
  android: {
    allowMixedContent: true,
    adjustMarginsForEdgeToEdge: "force",
  },
  plugins: {
    Camera: {
      presentationStyle: "fullscreen",
    },
  },
};

export default config;
