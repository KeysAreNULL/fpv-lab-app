/**
 * Build the debug APK and tell the pilot where it landed.
 *
 * Two things about a Gradle build trip people up on Windows, both handled here:
 *
 *  1. The wrapper ships twice — `gradlew` is a POSIX shell script and
 *     `gradlew.bat` is the cmd.exe equivalent. An npm script runs under cmd.exe,
 *     where the bare `gradlew` is not executable and the build produces nothing.
 *  2. Android Gradle Plugin 8.x needs JDK 17+. `JAVA_HOME` is frequently unset,
 *     and PATH often resolves to an old JRE, which fails with a wall of
 *     "compatible with Java 8" dependency errors. We locate a JDK 17+ ourselves
 *     and hand it to Gradle, falling back to the runtime bundled with Android
 *     Studio before giving up.
 *
 * The APK is written deep inside the Gradle build tree, which is easy to lose,
 * so the path is printed on success.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIN_JDK = 17;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const androidDir = join(root, 'android');

/** Candidate JDK homes, most authoritative first. */
function jdkCandidates() {
  const home = process.env.JAVA_HOME;
  return [
    home,
    join(process.env.PROGRAMFILES ?? '', 'Android', 'Android Studio', 'jbr'),
    join(process.env.PROGRAMFILES ?? '', 'Eclipse Adoptium'),
    join(process.env.PROGRAMFILES ?? '', 'Java'),
    join(process.env['PROGRAMFILES(X86)'] ?? '', 'Java'),
  ].filter(Boolean);
}

/** Major version of a JDK at `dir`, or null if it is missing or not a JDK. */
function jdkMajor(dir) {
  if (!dir || !existsSync(dir)) return null;
  const bin = join(dir, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
  if (!existsSync(bin)) return null;
  const probe = spawnSync(bin, ['-version'], { encoding: 'utf8' });
  // java writes version banners to stderr.
  const banner = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  const match = banner.match(/version "(\d+)/);
  return match ? Number(match[1]) : null;
}

function findJdk() {
  for (const candidate of jdkCandidates()) {
    const major = jdkMajor(candidate);
    if (major !== null && major >= MIN_JDK) return { dir: candidate, major };
  }
  return null;
}

const jdk = findJdk();
if (!jdk) {
  console.error(
    `No JDK ${MIN_JDK}+ found. Android Studio's bundled runtime works —\n` +
      'install Android Studio, or set JAVA_HOME to a JDK 17+ install, then re-run.',
  );
  process.exit(1);
}
console.log(`Using JDK ${jdk.major} at ${jdk.dir}`);

/**
 * Locate the Android SDK. Gradle reads ANDROID_HOME/ANDROID_SDK_ROOT or a
 * machine-specific `local.properties`; the latter is usually absent on a fresh
 * clone, so resolve the standard install location and pass it through the
 * environment rather than writing a machine-specific file into the repo.
 */
function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(process.env.LOCALAPPDATA ?? '', 'Android', 'Sdk'),
    join(process.env.USERPROFILE ?? '', 'AppData', 'Local', 'Android', 'Sdk'),
    'C:\\Android\\Sdk',
  ].filter(Boolean);
  for (const dir of candidates) {
    if (existsSync(join(dir, 'platforms')) || existsSync(join(dir, 'platform-tools'))) return dir;
  }
  return null;
}

const sdk = findSdk();
if (!sdk) {
  console.error(
    'Android SDK not found. Install Android Studio, or set ANDROID_HOME to your SDK path, then re-run.',
  );
  process.exit(1);
}
console.log(`Using Android SDK at ${sdk}`);

const wrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
const result = spawnSync(wrapper, ['assembleDebug'], {
  cwd: androidDir,
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: {
    ...process.env,
    JAVA_HOME: jdk.dir,
    ANDROID_HOME: sdk,
    ANDROID_SDK_ROOT: sdk,
    PATH: `${join(jdk.dir, 'bin')}${delimiter}${process.env.PATH ?? ''}`,
  },
});

if (result.error) {
  console.error(`Could not run ${wrapper}: ${result.error.message}`);
  process.exit(1);
}
if (result.status !== 0) process.exit(result.status ?? 1);

const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
console.log(existsSync(apk) ? `\nAPK: ${apk}` : '\nBuild finished but no APK was produced.');