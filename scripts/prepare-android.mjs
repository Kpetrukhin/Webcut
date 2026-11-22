import {execSync} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const androidDir = path.join(root, 'android');

if (!fs.existsSync(androidDir)) {
  console.log('Adding Capacitor Android platform...');
  execSync('npx cap add android', {stdio: 'inherit'});
}

// 1. Patch AndroidManifest.xml for cleartext LAN/ZeroTier + UDP Multicast + media permissions
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
    'android.permission.ACCESS_NETWORK_STATE',
    'android.permission.ACCESS_WIFI_STATE',
    'android.permission.CHANGE_WIFI_MULTICAST_STATE',
    'android.permission.READ_MEDIA_VIDEO',
    'android.permission.READ_MEDIA_IMAGES',
    'android.permission.READ_MEDIA_AUDIO',
    'android.permission.READ_EXTERNAL_STORAGE',
    'android.permission.RECORD_AUDIO',
    'android.permission.MODIFY_AUDIO_SETTINGS',
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
  console.log('Patched AndroidManifest.xml with LAN/ZeroTier, UDP multicast & media permissions.');
}

// 2. Patch root android/build.gradle for Kotlin 2.0.21
const rootGradlePath = path.join(androidDir, 'build.gradle');
if (fs.existsSync(rootGradlePath)) {
  let rootGradle = fs.readFileSync(rootGradlePath, 'utf-8');
  if (!rootGradle.includes('kotlin-gradle-plugin')) {
    rootGradle = rootGradle.replace(
      "classpath 'com.android.tools.build:gradle:",
      "classpath 'org.jetbrains.kotlin:kotlin-gradle-plugin:2.0.21'\n        classpath 'com.android.tools.build:gradle:"
    );
    fs.writeFileSync(rootGradlePath, rootGradle, 'utf-8');
    console.log('Patched android/build.gradle with Kotlin Gradle plugin 2.0.21.');
  }
}

// 3. Patch android/app/build.gradle with kotlin-android + Ktor CIO server/client + coroutines
const appGradlePath = path.join(androidDir, 'app/build.gradle');
if (fs.existsSync(appGradlePath)) {
  let appGradle = fs.readFileSync(appGradlePath, 'utf-8');
  if (!appGradle.includes("apply plugin: 'kotlin-android'")) {
    appGradle = appGradle.replace(
      "apply plugin: 'com.android.application'",
      "apply plugin: 'com.android.application'\napply plugin: 'kotlin-android'"
    );
  }

  if (!appGradle.includes('jvmTarget =')) {
    appGradle = appGradle.replace(
      'buildTypes {',
      `compileOptions {\n        sourceCompatibility JavaVersion.VERSION_21\n        targetCompatibility JavaVersion.VERSION_21\n    }\n    kotlinOptions {\n        jvmTarget = '21'\n        freeCompilerArgs += ['-opt-in=androidx.media3.common.util.UnstableApi']\n    }\n    packaging {\n        resources {\n            excludes += ['META-INF/INDEX.LIST', 'META-INF/io.netty.versions.properties', 'META-INF/DEPENDENCIES', 'META-INF/LICENSE*', 'META-INF/NOTICE*', 'META-INF/*.kotlin_module']\n        }\n    }\n    buildTypes {`
    );
  }

  if (!appGradle.includes('io.ktor:ktor-server-cio-jvm')) {
    const ktorDeps = `
    def ktorVersion = '2.3.12'
    implementation "io.ktor:ktor-server-core-jvm:$ktorVersion"
    implementation "io.ktor:ktor-server-cio-jvm:$ktorVersion"
    implementation "io.ktor:ktor-server-websockets-jvm:$ktorVersion"
    implementation "io.ktor:ktor-client-core-jvm:$ktorVersion"
    implementation "io.ktor:ktor-client-cio-jvm:$ktorVersion"
    implementation "io.ktor:ktor-client-websockets-jvm:$ktorVersion"
    implementation 'org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1'
`;
    appGradle = appGradle.replace(
      "implementation project(':capacitor-android')",
      `implementation project(':capacitor-android')${ktorDeps}`
    );
  }

  if (!appGradle.includes('androidx.media3:media3-transformer')) {
    const media3Deps = `
    def media3Version = '1.5.1'
    implementation "androidx.media3:media3-transformer:$media3Version"
    implementation "androidx.media3:media3-exoplayer:$media3Version"
    implementation "androidx.media3:media3-effect:$media3Version"
    implementation "androidx.media3:media3-common:$media3Version"
`;
    appGradle = appGradle.replace(
      "implementation project(':capacitor-android')",
      `implementation project(':capacitor-android')${media3Deps}`
    );
  }

  if (!appGradle.includes('io.coil-kt:coil')) {
    const coilDeps = `
    def coilVersion = '2.7.0'
    implementation "io.coil-kt:coil:$coilVersion"
    implementation "io.coil-kt:coil-gif:$coilVersion"
`;
    appGradle = appGradle.replace(
      "implementation project(':capacitor-android')",
      `implementation project(':capacitor-android')${coilDeps}`
    );
  }

  fs.writeFileSync(appGradlePath, appGradle, 'utf-8');
  console.log('Patched android/app/build.gradle with Ktor 2.3.12 CIO, Media3 1.5.1, Coil 2.7.0 (GIF/AnimatedWebP) + Kotlin 21.');
}

// 4. Copy native Kotlin Ktor P2P plugin files & wire MainActivity.java
const targetJavaDir = path.join(
  androidDir,
  'app/src/main/java/com/cutsync/webcut'
);
fs.mkdirSync(targetJavaDir, {recursive: true});

const nativeSrcDir = path.join(
  root,
  'android-native/src/main/java/com/cutsync/webcut'
);
if (fs.existsSync(nativeSrcDir)) {
  for (const file of fs.readdirSync(nativeSrcDir)) {
    if (file.endsWith('.kt') || file.endsWith('.java')) {
      fs.copyFileSync(
        path.join(nativeSrcDir, file),
        path.join(targetJavaDir, file)
      );
    }
  }
  console.log('Copied native Kotlin Ktor P2P files to Android project.');
}

const mainActivityPath = path.join(targetJavaDir, 'MainActivity.java');
const mainActivityCode = `package com.cutsync.webcut;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(LanSyncPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
`;
fs.writeFileSync(mainActivityPath, mainActivityCode, 'utf-8');
console.log('Updated MainActivity.java to register LanSyncPlugin.');

// 5. Copy PWA icon into Android mipmap launcher resources
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
