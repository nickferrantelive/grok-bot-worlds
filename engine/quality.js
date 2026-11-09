// Quality presets. Auto pick, with ?quality=desktop|phone as the override.

export const PRESETS = {
  desktop: { name: 'desktop', shadows: true, post: true, detail: 1, maxPixelRatio: 2 },
  phone: { name: 'phone', shadows: false, post: false, detail: 0.5, maxPixelRatio: 1.5 },
};

function softwareRenderer(gl) {
  try {
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const text = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    return /swiftshader|llvmpipe|software/i.test(text);
  } catch {
    return false;
  }
}

export function autoQualityName({ userAgent = '', coarsePointer = false, minScreen = 1080, software = false }) {
  if (software) return 'phone';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(userAgent)) return 'phone';
  if (coarsePointer && minScreen <= 900) return 'phone';
  return 'desktop';
}

export function pickQuality({ params, renderer, capture }) {
  const wanted = params.get('quality');
  let name;
  let source = 'auto';
  if (wanted && wanted !== 'auto') {
    if (!PRESETS[wanted]) throw new Error(`quality=${wanted} is not a preset. Use desktop or phone.`);
    name = wanted;
    source = 'url';
  } else if (capture) {
    name = 'desktop';
    source = 'capture';
  } else {
    name = autoQualityName({
      userAgent: navigator.userAgent,
      coarsePointer: matchMedia('(pointer: coarse)').matches,
      minScreen: Math.min(screen.width, screen.height),
      software: softwareRenderer(renderer.getContext()),
    });
  }
  const preset = PRESETS[name];
  const dprParam = Number(params.get('dpr'));
  const pixelRatio = dprParam > 0 ? dprParam : capture ? 1 : Math.min(devicePixelRatio || 1, preset.maxPixelRatio);
  return {
    quality: { name: preset.name, shadows: preset.shadows, post: preset.post, pixelRatio, detail: preset.detail },
    source,
  };
}

// Rolling frame rate. Publishes window.__fps. Lowers the pixel ratio if an auto pick cannot keep up.
export function createFrameMeter({ renderer, quality, canAdapt, onResolutionChange }) {
  const samples = new Float32Array(90);
  let filled = 0;
  let head = 0;
  let slowFor = 0;
  let fps = 0;
  return {
    get fps() {
      return fps;
    },
    tick(rawDt) {
      if (rawDt <= 0) return;
      samples[head] = rawDt;
      head = (head + 1) % samples.length;
      filled = Math.min(filled + 1, samples.length);
      let sum = 0;
      for (let i = 0; i < filled; i += 1) sum += samples[i];
      fps = filled / sum;
      globalThis.__fps = fps;
      if (!canAdapt || filled < samples.length) return;
      slowFor = fps < 26 ? slowFor + rawDt : 0;
      if (slowFor > 4 && quality.pixelRatio > 1) {
        quality.pixelRatio = Math.max(1, quality.pixelRatio - 0.25);
        renderer.setPixelRatio(quality.pixelRatio);
        onResolutionChange?.();
        slowFor = 0;
        filled = 0;
      }
    },
  };
}
