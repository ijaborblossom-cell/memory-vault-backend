import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.memoryvault.app',
  appName: 'Memory Vault',
  webDir: 'src',
  server: {
    // This makes the app always load the latest version from your website!
    url: 'https://memory-vault-coral-seven.vercel.app',
    cleartext: true
  }
};

export default config;
