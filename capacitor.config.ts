import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'dev.fpvlab.app',
  appName: 'FPV Lab',
  webDir: 'dist',
  android: {
    // Keeps WebGL context alive when the app is backgrounded on Android.
    backgroundColor: '#0b0f14',
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
};

export default config;
