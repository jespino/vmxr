// Emulated headset for desktops without a VR device, using Meta's Immersive
// Web Emulation Runtime (IWER) plus its DevUI overlay.
//
//   default      → emulate only when the browser reports no native VR
//   ?emulate=1   → always emulate (even over a real headset)
//   ?emulate=0   → never emulate
//   ?devui=0     → emulate without the control overlay (for scripted tests)
//
// Loaded lazily, so headset users never download it.

export async function maybeInstallEmulator() {
  const param = new URLSearchParams(location.search).get('emulate');
  if (param === '0') return null;
  // WebXR (emulated or not) is only exposed to secure contexts.
  if (!window.isSecureContext) return null;
  if (param !== '1' && navigator.xr) {
    const native = await navigator.xr.isSessionSupported('immersive-vr').catch(() => false);
    if (native) return null; // a real headset is available: never override it
  }
  const [{ XRDevice, metaQuest3 }, { DevUI }] = await Promise.all([
    import('iwer'),
    import('@iwer/devui'),
  ]);
  const device = new XRDevice(metaQuest3);
  // Chromium exposes a native navigator.xr even with no device attached, so
  // the emulated runtime has to be forced in.
  device.installRuntime({ forceInstall: true });
  // ?devui=0 keeps the runtime but drops the overlay (scripted tests drive
  // window.__iwer directly; the overlay would overwrite their input each frame)
  if (new URLSearchParams(location.search).get('devui') !== '0') device.installDevUI(DevUI);
  if (import.meta.env.DEV) window.__iwer = device; // lets scripts drive the emulated controllers
  return device;
}
