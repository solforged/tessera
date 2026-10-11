# Sourced by the Android tasks. Keeps NDK_HOME when set; otherwise takes the
# newest NDK in the Android SDK at ANDROID_HOME.
if [ -z "${NDK_HOME:-}" ]; then
  NDK_HOME=$(find "${ANDROID_HOME:-}/ndk" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | sort -V | tail -n 1)
  if [ -z "$NDK_HOME" ]; then
    echo "Set NDK_HOME, or install an NDK into the SDK: sdkmanager --install 'ndk;<version>'." >&2
    exit 1
  fi
fi
export NDK_HOME
