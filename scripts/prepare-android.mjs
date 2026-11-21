import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const androidDir = path.join(root, 'android');

if (!fs.existsSync(androidDir)) {
  console.log('Adding Capacitor Android platform...');
  execSync('npx cap add android', {stdio: 'inherit'});
}

// Patch AndroidManifest.xml for cleartext LAN servers + media gallery permissions
const manifestPath = path.join(
  androidDir,
  'app/src/main/AndroidManifest.xml'
);
if (fs.existsSync(manifestPath)) {
  let manifest = fs.readFileSync(manifestPath, 'utf-8');

  if (!manifest.includes('android:usesCleartextTraffic')) {
    manifest = manifest.replace(
      '<application',
      '<application\n        android:usesCleartextTraffic="true"'
    );
  }

  const requiredPermissions = [
    'android.permission.INTERNET',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
  ];

  for (const perm of requiredPermissions) {
    if (!manifest.includes(perm)) {
      manifest = manifest.replace(
        '</manifest>',
        `    <uses-permission android:name="${perm}" />\n</manifest>`
      );
    }
  }

  fs.writeFileSync(manifestPath, manifest, 'utf-8');
  console.log('Patched AndroidManifest.xml with media & network permissions.');
}

// Copy PWA icon into Android mipmap launcher resources
const icon512 = path.join(root, 'public/pwa-512x512.png');
const icon192 = path.join(root, 'public/pwa-192x192.png');
const iconMaskable = path.join(root, 'public/pwa-maskable-512x512.png');
const resDir = path.join(androidDir, 'app/src/main/res');
if (fs.existsSync(resDir) && fs.existsSync(icon512) && fs.existsSync(icon192)) {
  const targets = [
    ['mipmap-mdpi', icon192],
    ['mipmap-hdpi', icon192],
    ['mipmap-xhdpi', icon192],
    ['mipmap-xxhdpi', icon512],
    ['mipmap-xxxhdpi', icon512],
  ];
  for (const [folder, srcIcon] of targets) {
    const dir = path.join(resDir, folder);
    if (fs.existsSync(dir)) {
      fs.copyFileSync(srcIcon, path.join(dir, 'ic_launcher.png'));
      fs.copyFileSync(srcIcon, path.join(dir, 'ic_launcher_round.png'));
      if (fs.existsSync(iconMaskable)) {
        fs.copyFileSync(
          iconMaskable,
          path.join(dir, 'ic_launcher_foreground.png')
        );
      }
    }
  }
  console.log('Copied CutSync launcher icons to Android mipmap folders.');
}

execSync('npx cap sync android', {stdio: 'inherit'});
