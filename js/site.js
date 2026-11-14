import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

/* ---------- environment ---------- */
const html = document.documentElement;
const { gsap, ScrollTrigger } = window;
if (!gsap || !ScrollTrigger) throw new Error('GSAP failed to load; the static fallback stays on');
html.classList.remove('no-js');
html.classList.add('js-on');
gsap.registerPlugin(ScrollTrigger);
ScrollTrigger.config({ ignoreMobileResize: true });

const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/* any touchscreen counts: a touch laptop scrolls natively by finger, where WebGL photo planes would trail a frame */
const touch = window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(any-pointer: coarse)').matches;
const seen = html.classList.contains('seen'); // a repeat view in this tab (set in index.html): no loader, a quicker intro
const fine = window.matchMedia('(pointer: fine)').matches;
/* Software renderers (no GPU, virtual desktop, blocked driver) get the DOM photos instead of a scene at 2 frames
   per second. The flag catches Chromium's own fallback; the renderer name also catches Firefox and forced headless runs.
   ponytail: a slow real GPU still gets WebGL; add a frame-time watchdog if that is ever reported. */
const hasGL = !reduced && (() => { try {
  const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
  const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
  return !!gl && !/swiftshader|basic render|llvmpipe|softpipe/i.test(gl.getParameter(dbg ? dbg.UNMASKED_RENDERER_WEBGL : gl.RENDERER));
} catch (e) { return false; } })();
let useGL = hasGL;
/* on touch the DOM draws the photos: native scroll runs off-thread, so GL planes would trail by a frame */
const usePlanes = () => useGL && !touch && !html.classList.contains('js-failed'); // late boot: the static page keeps its DOM photos
if (reduced) html.classList.add('no-motion');

/* ---------- split text ---------- */
function splitWords(root) {
  const walk = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === 3) {
        const parts = child.textContent.split(/(\s+)/);
        const frag = document.createDocumentFragment();
        parts.forEach((p) => {
          if (!p) return;
          if (/^\s+$/.test(p)) { frag.appendChild(document.createTextNode(' ')); return; }
          const w = document.createElement('span'); w.className = 'w';
          const i = document.createElement('span'); i.className = 'wi'; i.textContent = p;
          w.appendChild(i); frag.appendChild(w);
        });
        node.replaceChild(frag, child);
      } else if (child.nodeType === 1 && !child.classList.contains('w')) {
        walk(child);
      }
    });
  };
  walk(root);
  return root.querySelectorAll('.wi');
}
document.querySelectorAll('[data-split]').forEach((el) => splitWords(el));

/* ---------- smooth scroll ---------- */
let lenis = null;
let scrollVel = 0;
if (!reduced && window.Lenis) {
  lenis = window.__lenis = new window.Lenis({ lerp: 0.085, smoothWheel: true, syncTouch: false, wheelMultiplier: 0.95 });
  lenis.on('scroll', (e) => {
    scrollVel = e.velocity;
    ScrollTrigger.update();
    /* the browser scrolling on its own (keyboard, scrollbar, touch): the page photos stand in for the planes (css gl-native) */
    const native = e.isScrolling === 'native' && GL.planes.length > 0;
    if (native !== GL.native) { GL.native = native; html.classList.toggle('gl-native', native); }
  });
  gsap.ticker.add((t) => lenis.raf(t * 1000));
  gsap.ticker.lagSmoothing(0);
  /* no scroll lock under the loader: it is short now, and a lock is one more thing a failed boot could leave behind */
}
const focusTarget = (target) => {
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
};
document.querySelectorAll('a[href^="#"]').forEach((a) => {
  a.addEventListener('click', (e) => {
    const id = a.getAttribute('href');
    if (id.length < 2) return;
    const target = document.querySelector(id);
    if (!target) return;
    e.preventDefault();
    /* Lenis ignores scroll-margin-top (css: it keeps section labels clear of the nav bar), so pass it as the offset */
    const offset = -(parseFloat(getComputedStyle(target).scrollMarginTop) || 0);
    const far = Math.abs(target.getBoundingClientRect().top) > innerHeight * 1.5;
    if (lenis && far) {
      /* a long way off: a quick fade and a cut instead of a ride across the whole page (it went 4,400px in 1.4 s) */
      const main = document.querySelector('main');
      gsap.timeline()
        .to(main, { opacity: 0, duration: 0.22, ease: 'power2.in' })
        .add(() => { lenis.scrollTo(target, { offset, immediate: true, force: true }); GL.vel = 0; ScrollTrigger.update(); focusTarget(target); })
        .to(main, { opacity: 1, duration: 0.45, ease: 'power2.out', clearProps: 'opacity' });
    } else if (lenis) {
      lenis.scrollTo(target, { offset, duration: 1.0, easing: (t) => 0.5 - 0.5 * Math.cos(Math.PI * t), onComplete: () => focusTarget(target) });
    } else { target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }); focusTarget(target); }
  });
});

/* ---------- loader: the wordmark alone, for as long as real loading takes ---------- */
const loader = document.getElementById('loader');

/* ---------- WebGL ---------- */
const canvas = document.getElementById('gl');
/* fade starts at 0, so the dust fades in once the page shows; time stops while "Pause motion" is on */
const GL = { planes: [], fade: 0, fadeTarget: 1, mouse: new THREE.Vector2(0, 0), mouseT: new THREE.Vector2(0, 0), vel: 0, time: 0, paused: html.classList.contains('motion-paused'), native: false };
const W = () => canvas.clientWidth || html.clientWidth;
const H = () => canvas.clientHeight || window.innerHeight;
function pickRatio(w, h) {
  const dpr = window.devicePixelRatio || 1;
  /* touch screens draw at 1.5x at most: the soft dust and grain look the same, with 44% fewer pixels per pass */
  return Math.max(1, Math.min(dpr, touch ? 1.5 : 2, Math.sqrt(4.5e6 / Math.max(1, w * h))));
}

const noiseGLSL = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
  vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g; vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
  i=mod289(i);
  vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
  float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
  vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
  vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0); m=m*m;
  return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}`;

const particleVert = `
${noiseGLSL}
attribute vec3 aSeed;
attribute float aSize;
uniform float uTime, uBreath, uFade, uPixelRatio, uVel;
uniform vec2 uMouse, uArea;
uniform vec4 uQuiet; // the text block on screen (left, bottom, right, top, from the centre, y up): dust thins out over it
varying float vAlpha;
void main(){
  vec3 p;
  p.x = (aSeed.x - 0.5) * uArea.x * 1.25;
  p.y = (aSeed.y - 0.5) * uArea.y * 1.25;
  p.z = (aSeed.z - 0.5) * 700.0;
  float t = uTime * 0.05;
  float sc = 0.0011;
  vec3 n = vec3(
    snoise(vec3(p.xy * sc, t + aSeed.z * 3.0)),
    snoise(vec3(p.yx * sc + 31.0, t - aSeed.x * 3.0)),
    snoise(vec3(p.xz * sc + 57.0, t * 0.7)));
  p += n * vec3(120.0, 120.0, 60.0);
  p.xy *= uBreath;
  vec2 d = p.xy - uMouse;
  float dist = length(d);
  float f = smoothstep(300.0, 0.0, dist);
  p.xy += (d / max(dist, 1.0)) * f * 60.0;
  p.y += uVel * (0.35 + aSeed.z) * 2.2 + sin(uTime * 0.25 + aSeed.x * 6.2832) * 18.0;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  gl_Position = projectionMatrix * mv;
  float depth = smoothstep(-450.0, 350.0, p.z);
  gl_PointSize = min(aSize * uPixelRatio * (900.0 / -mv.z), 48.0);
  vAlpha = (0.12 + 0.7 * depth) * uFade * (0.5 + 0.5 * n.x) * (1.0 - f * 0.5) * 0.85;
  /* quiet zone: 20% strength inside the text block, back to full over 140px outside it, so there is no edge */
  vec2 sp = gl_Position.xy / gl_Position.w * 0.5 * uArea;
  vec2 dq = max(max(uQuiet.xy - sp, sp - uQuiet.zw), 0.0);
  vAlpha *= mix(0.2, 1.0, smoothstep(0.0, 140.0, length(dq)));
}`;
const particleFrag = `
uniform vec3 uColor;
varying float vAlpha;
void main(){
  vec2 c = gl_PointCoord - 0.5;
  float d = length(c);
  float a = smoothstep(0.5, 0.12, d) * 0.9;
  gl_FragColor = vec4(uColor, a * vAlpha);
}`;

const planeVert = `
uniform float uVel;
uniform vec2 uPlane;
varying vec2 vUv;
void main(){
  vUv = uv;
  vec3 p = position;
  p.y += sin(uv.x * 3.14159) * uVel * 0.3 / max(uPlane.y, 1.0);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;
const planeFrag = `
uniform sampler2D uTex;
uniform vec2 uPlane, uImage, uFocus;
uniform float uVel, uReveal, uOpacity, uTopR, uBotR, uPx;
varying vec2 vUv;
vec2 cover(vec2 uv, vec2 plane, vec2 img){
  float pr = plane.x / plane.y; float ir = img.x / img.y;
  vec2 s = vec2(1.0);
  if (pr > ir) s.y = ir / pr; else s.x = pr / ir;
  vec2 origin = uFocus * (vec2(1.0) - s);
  return origin + uv * s;
}
void main(){
  vec2 uv = vUv;
  float z = mix(1.16, 1.0, uReveal);
  uv = (uv - 0.5) / z + 0.5;
  vec2 cuv = cover(uv, uPlane, uImage);
  float sp = uVel * 0.00022;
  float r = texture2D(uTex, cuv + vec2(0.0, sp)).r;
  float g = texture2D(uTex, cuv).g;
  float b = texture2D(uTex, cuv - vec2(0.0, sp)).b;
  vec3 col = vec3(r, g, b); // no extra grade here: laptops and phones show the photos the same
  float e = uReveal * 1.12;
  float wipe = 1.0 - smoothstep(e - 0.12, e, 1.0 - vUv.y);
  /* mask: rounded box whose top and bottom corners can differ (arch = top radius of half the width) */
  vec2 hb = uPlane * 0.5;
  vec2 q = (vUv - 0.5) * uPlane;
  float rr = q.y > 0.0 ? uTopR : uBotR;
  rr = min(rr, min(hb.x, hb.y));
  vec2 d2 = abs(q) - hb + rr;
  float sd = length(max(d2, 0.0)) + min(max(d2.x, d2.y), 0.0) - rr;
  float aa = max(uPx, 1e-4);
  float mask = 1.0 - smoothstep(-2.0 * aa, 0.0, sd);
  gl_FragColor = vec4(col, wipe * uOpacity * mask);
}`;

/* grain runs after OutputPass, so it works in display (sRGB) space */
const grainShader = {
  uniforms: { tDiffuse: { value: null }, uTime: { value: 0 }, uAmount: { value: 0.05 }, uRes: { value: new THREE.Vector2(1, 1) }, uGlow: { value: 1 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
  uniform sampler2D tDiffuse; uniform float uTime, uAmount, uGlow; uniform vec2 uRes; varying vec2 vUv;
  float hash(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
  void main(){
    vec4 c = texture2D(tDiffuse, vUv);
    /* film grain: a new pattern 24 times a second, strongest in the mid-tones, so the black behind the words stays black */
    float ft = floor(uTime * 24.0);
    float lum = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
    float g = (hash(vUv * uRes + vec2(fract(ft * 0.137) * 100.0, fract(ft * 0.073) * 100.0)) - 0.5) * uAmount * (0.35 + 2.6 * lum * (1.0 - lum));
    vec2 q = vUv - 0.5;
    float vig = 1.0 - dot(q, q) * 0.28;
    /* the warm light is measured from the screen's short side, so it stays a patch on tall phone screens */
    vec2 sc = uRes / min(uRes.x, uRes.y);
    vec2 gp = vec2(0.18 + 0.06 * sin(uTime * 0.11), 0.22 + 0.05 * cos(uTime * 0.09));
    float glow = smoothstep(0.7, 0.0, distance(vUv * sc, gp * sc));
    c.rgb = c.rgb * vig + vec3(0.29, 0.22, 0.13) * glow * uGlow * 0.22 + g;
    gl_FragColor = vec4(clamp(c.rgb, 0.0, 1.0), 1.0);
  }`,
};

let renderer, scene, camera, composer, grainPass, particles, pMat, clock;
let lastW = 0, lastH = 0;

function initGL(manager) {
  /* default power preference: the integrated GPU handles this easily, and dual-GPU laptops stay cool */
  renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  renderer.setPixelRatio(pickRatio(W(), H()));
  renderer.setSize(W(), H(), false);
  renderer.setClearColor(new THREE.Color('#0B0B0C'), 1);
  scene = new THREE.Scene();
  /* the clear color set above is encoded for the screen, but the composer clears a linear target with it,
     so OutputPass encoded it twice and the page drew #3A3A3A. A scene background clears in linear space. */
  scene.background = new THREE.Color('#0B0B0C');
  const dist = 1000;
  camera = new THREE.PerspectiveCamera(2 * Math.atan((H() / 2) / dist) * 180 / Math.PI, W() / H(), 10, 3000);
  camera.position.z = dist;
  clock = new THREE.Clock();

  composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  composer.addPass(new OutputPass());
  grainPass = new ShaderPass(grainShader);
  composer.addPass(grainPass);

  /* particles */
  /* phones: fewer and smaller specks, so none is bigger than a letter */
  const N = touch ? 1200 : 6500;
  const geo = new THREE.BufferGeometry();
  const pos = new Float32Array(N * 3), seed = new Float32Array(N * 3), size = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    seed[i * 3] = Math.random(); seed[i * 3 + 1] = Math.random(); seed[i * 3 + 2] = Math.random();
    size[i] = touch ? 1.2 + Math.pow(Math.random(), 2.2) * 3.8 : 1.6 + Math.pow(Math.random(), 2.2) * 6.5;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(size, 1));
  pMat = new THREE.ShaderMaterial({
    vertexShader: particleVert, fragmentShader: particleFrag, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
    uniforms: {
      uTime: { value: 0 }, uBreath: { value: 1 }, uFade: { value: 0 }, uPixelRatio: { value: renderer.getPixelRatio() }, uVel: { value: 0 },
      uMouse: { value: new THREE.Vector2(9999, 9999) }, uArea: { value: new THREE.Vector2(W(), H()) }, uColor: { value: new THREE.Color('#E6C69A') },
      uQuiet: { value: new THREE.Vector4(1e5, 1e5, -1e5, -1e5) },
    },
  });
  particles = new THREE.Points(geo, pMat);
  particles.frustumCulled = false;
  scene.add(particles);

  /* photo planes: the DOM <img> is the texture source, so each photo is fetched once */
  if (usePlanes()) {
    const planeGeo = new THREE.PlaneGeometry(1, 1, 24, 24);
    document.querySelectorAll('.gl-fig[data-gl]').forEach((fig) => {
      const img = fig.querySelector('img');
      const shown = fig.getClientRects().length > 0; // the hero figure is display:none below 981 px: leave it lazy, do not wait for it
      const gatesLoader = shown && !!fig.closest('.hero');
      const tex = new THREE.Texture();
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true;
      tex.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      const f = (fig.dataset.focus || '0.5 0.5').split(/\s+/).map(Number);
      const mat = new THREE.ShaderMaterial({
        vertexShader: planeVert, fragmentShader: planeFrag, transparent: true,
        uniforms: {
          uTex: { value: tex }, uPlane: { value: new THREE.Vector2(1, 1) },
          uImage: { value: new THREE.Vector2(+img.getAttribute('width') || 3, +img.getAttribute('height') || 2) },
          uVel: { value: 0 }, uReveal: { value: 0 },
          uFocus: { value: new THREE.Vector2(f[0], 1 - f[1]) }, uOpacity: { value: 1 },
          uTopR: { value: 0 }, uBotR: { value: 0 }, uPx: { value: 1 },
        },
      });
      const mesh = new THREE.Mesh(planeGeo, mat);
      mesh.frustumCulled = false;
      mesh.visible = false;
      scene.add(mesh);
      const plane = { fig, img, mesh, mat, shape: fig.dataset.shape || 'rect', loaded: false, wanted: false, dead: false, gates: gatesLoader };
      plane.syncOpacity = () => { mat.uniforms.uOpacity.value = parseFloat(getComputedStyle(fig).opacity) || 1; };
      plane.syncOpacity();
      plane.reveal = () => gsap.to(mat.uniforms.uReveal, { value: 1, duration: 1.7, ease: 'expo.out' });
      plane.want = () => { plane.wanted = true; if (plane.loaded) plane.reveal(); };
      GL.planes.push(plane);
      if (gatesLoader) manager.itemStart(img.src);
      if (shown) img.loading = 'eager';
      /* three.js gets its own copy of the photo, from the same file (one download). The page <img> reports its
         layout width, not the file's: in windows over about 2063px that made three.js ask for more mip levels than
         the picture has, the upload failed and the big photo drew black. A copy reports the file's own size. */
      const pix = new Image();
      const ready = () => {
        tex.image = pix; tex.needsUpdate = true;
        try {
          const gl = renderer.getContext();
          gl.getError(); // clear anything older, so the check below only sees this upload
          renderer.initTexture(tex);
          if (gl.getError() !== gl.NO_ERROR) return failed(); // never a black box: the page photo shows instead
        } catch (e) { /* upload happens on first draw */ }
        plane.loaded = true;
        if (plane.wanted) plane.reveal();
        if (gatesLoader) manager.itemEnd(img.src);
      };
      const failed = () => { plane.dead = true; fig.classList.add('gl-off'); if (gatesLoader) manager.itemEnd(img.src); };
      (img.decode ? img.decode() : Promise.resolve())
        .catch(() => { if (!img.naturalWidth) throw new Error('photo did not load'); })
        .then(() => { pix.src = img.currentSrc || img.src; return pix.decode ? pix.decode() : undefined; })
        .then(ready, () => (pix.naturalWidth ? ready() : failed()));
    });
    html.classList.add('gl-planes');
  }

  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    gsap.ticker.remove(render);
    html.classList.remove('gl-on', 'gl-planes');
    GL.planes.forEach((p) => { p.mesh.visible = false; });
    renderer = null;
  });

  html.classList.add('gl-on');
  window.addEventListener('resize', onResize);
  onResize();
}

function onResize() {
  if (!renderer) return;
  const w = W(), h = H();
  if (w === lastW && h === lastH) return;
  lastW = w; lastH = h;
  renderer.setPixelRatio(pickRatio(w, h));
  const pr = renderer.getPixelRatio();
  renderer.setSize(w, h, false);
  composer.setPixelRatio(pr);
  composer.setSize(w, h);
  camera.aspect = w / h;
  camera.fov = 2 * Math.atan((h / 2) / 1000) * 180 / Math.PI;
  camera.updateProjectionMatrix();
  pMat.uniforms.uArea.value.set(w, h);
  pMat.uniforms.uPixelRatio.value = pr;
  grainPass.uniforms.uRes.value.set(w * pr, h * pr);
  for (const p of GL.planes) { p.syncOpacity(); p.mat.uniforms.uPx.value = 1 / pr; }
}

let hidden = false;
document.addEventListener('visibilitychange', () => { hidden = document.hidden; });

const QUIET = '.hero-copy, .contact-head, .form';
function render() {
  if (!renderer || hidden) return;
  onResize(); // no-op when the size is unchanged; fixes a renderer sized before the stylesheet applied (Safari runs deferred scripts without waiting for it)
  const dt = clock.getDelta();
  if (!GL.paused) GL.time += dt; // "Pause motion" stops the clock: dust, breath, glow and grain all hold still
  const t = GL.time;
  const w = W(), h = H();
  GL.vel += (Math.max(-30, Math.min(30, scrollVel)) - GL.vel) * 0.1;
  GL.mouse.lerp(GL.mouseT, 0.08);
  GL.fade += (GL.fadeTarget - GL.fade) * 0.06;

  pMat.uniforms.uTime.value = t;
  pMat.uniforms.uBreath.value = 1 + Math.sin(t * Math.PI * 2 / 6.5) * 0.06;
  pMat.uniforms.uFade.value = GL.fade;
  pMat.uniforms.uVel.value = GL.paused ? 0 : GL.vel;
  if (GL.paused) pMat.uniforms.uMouse.value.set(9999, 9999); else pMat.uniforms.uMouse.value.copy(GL.mouse);
  particles.visible = GL.fade > 0.02;

  /* the dust thins out over the text block on screen (hero copy, contact heading, form) */
  let ql = 1e9, qt = 1e9, qr = -1e9, qb = -1e9;
  document.querySelectorAll(QUIET).forEach((el) => {
    const q = el.getBoundingClientRect();
    if (q.bottom < 0 || q.top > h || !q.width) return;
    ql = Math.min(ql, q.left); qt = Math.min(qt, q.top); qr = Math.max(qr, q.right); qb = Math.max(qb, q.bottom);
  });
  if (qr > ql) pMat.uniforms.uQuiet.value.set(ql - 24 - w / 2, -(qb + 24 - h / 2), qr + 24 - w / 2, -(qt - 24 - h / 2));
  else pMat.uniforms.uQuiet.value.set(1e5, 1e5, -1e5, -1e5);

  for (const p of GL.planes) {
    if (p.dead || !p.loaded || GL.native) { p.mesh.visible = false; continue; }
    const r = p.fig.getBoundingClientRect();
    const visible = r.bottom > -100 && r.top < h + 100 && r.width > 0;
    p.mesh.visible = visible;
    if (!visible) continue;
    p.mesh.scale.set(r.width, r.height, 1);
    p.mesh.position.set(r.left + r.width / 2 - w / 2, -(r.top + r.height / 2 - h / 2), 0);
    p.mat.uniforms.uPlane.value.set(r.width, r.height);
    if (p.shape === 'arch') { p.mat.uniforms.uTopR.value = r.width * 0.5; p.mat.uniforms.uBotR.value = 10; }
    else if (p.shape === 'round') { const rr = Math.min(r.width, r.height) * 0.5; p.mat.uniforms.uTopR.value = rr; p.mat.uniforms.uBotR.value = rr; }
    else if (p.shape === 'rect') { p.mat.uniforms.uTopR.value = 18; p.mat.uniforms.uBotR.value = 18; }
    else { p.mat.uniforms.uTopR.value = 0; p.mat.uniforms.uBotR.value = 0; }
    p.mat.uniforms.uVel.value = GL.vel;
  }
  grainPass.uniforms.uTime.value = t;
  grainPass.uniforms.uGlow.value = 0.35 + GL.fade * 0.65;
  composer.render();
}

/* ---------- boot ---------- */
const manager = new THREE.LoadingManager();
let assetsDone = false;
manager.onLoad = () => { assetsDone = true; maybeStart(); };
manager.onError = () => { assetsDone = true; maybeStart(); };

if (useGL) {
  try { initGL(manager); } catch (e) {
    console.warn('WebGL disabled:', e);
    useGL = false; html.classList.remove('gl-on', 'gl-planes'); GL.planes.length = 0;
  }
}
if (!useGL || !GL.planes.some((p) => p.gates)) assetsDone = true;
let fontsDone = false;
(document.fonts ? document.fonts.ready : Promise.resolve()).then(() => { fontsDone = true; loader.classList.add('fonts-in'); maybeStart(); });
setTimeout(() => { assetsDone = true; fontsDone = true; maybeStart(); }, 3000); // never wait past 3 s for fonts or the hero photo

let started = false;
function maybeStart() {
  if (started || !assetsDone || !fontsDone) return;
  started = true;
  /* no fixed wait: the wordmark stays only as long as loading takes, with a short floor on desktop so it never just blinks */
  const hold = touch || reduced || seen ? 0 : 400;
  setTimeout(start, Math.max(0, hold - performance.now()));
}

function start() {
  if (useGL && renderer) gsap.ticker.add(render);
  const hero = document.querySelector('.hero');
  const heroWords = hero.querySelectorAll('.wi');
  const heroLines = hero.querySelectorAll('.reveal-line');
  const name = loader.querySelector('.loader-name');
  const quick = seen; // a repeat view: no loader, a shorter rise
  const tl = gsap.timeline({ defaults: { ease: 'expo.out' } });
  /* hand-off, no curtain: the wordmark lifts away, the loader fades, the headline rises through it */
  if (!quick) tl.to(name, { y: -12, opacity: 0, duration: 0.35, ease: 'power2.in' }, 0);
  tl.to(loader, { opacity: 0, duration: quick ? 0.01 : 0.5, ease: 'power2.out', onComplete: () => { loader.style.display = 'none'; } }, quick ? 0 : 0.05)
    .add(() => { if (lenis) lenis.start(); GL.fadeTarget = 1; }, 0)
    .to(heroWords, { y: 0, duration: quick ? 0.6 : 1.0, stagger: quick ? 0.02 : 0.04, onComplete: () => hero.querySelector('.hero-title').classList.add('is-in') }, quick ? 0 : 0.2)
    .to(heroLines, { opacity: 1, y: 0, duration: quick ? 0.4 : 0.7, stagger: 0.1, ease: 'power3.out' }, quick ? 0.1 : 0.45)
    .add(() => { try { sessionStorage.setItem('bf-seen', '1'); } catch (e) {} });
  /* skip the intro when it would play over content the visitor already sees (reduced motion, or the static page shown after a slow load) */
  if (reduced || html.classList.contains('js-failed')) tl.progress(1);
  setupScroll();
  setupPointer();
  setupMagnetic();
  setupForm();
  setupMotionToggle();
  ScrollTrigger.refresh();
  window.__booted = true; // last: if anything above throws, the 4 s timer in index.html still brings the static page back
}

/* ---------- scroll choreography ---------- */
function setupScroll() {
  const late = html.classList.contains('js-failed'); // booting on top of the static page: do not hide what is already on screen
  const arrive = document.querySelector('.arrive');
  const arriveWords = arrive.querySelectorAll('.wi');
  const arriveCopy = arrive.querySelector('.arrive-copy');
  if (!late) gsap.set(arriveCopy, { opacity: 0, y: 24 });
  ScrollTrigger.create({ trigger: arrive, start: 'top 62%', once: true, onEnter: () => {
    gsap.to(arriveCopy, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out' });
    gsap.to(arriveWords, { y: 0, duration: 1.3, ease: 'expo.out', stagger: 0.03, overwrite: true, onComplete: () => arrive.querySelector('.arrive-lead').classList.add('is-in') });
  } });

  /* particle field: strong in the hero, faint through the page, back for the close */
  let heroFade = 1, closeFade = 0;
  const applyFade = () => { GL.fadeTarget = Math.max(heroFade, closeFade); };
  ScrollTrigger.create({ trigger: '.hero', start: 'top top', end: 'bottom 20%', onUpdate: (st) => { heroFade = 1 - st.progress * 0.9; applyFade(); } });
  ScrollTrigger.create({ trigger: '.contact', start: 'top 80%', end: 'bottom bottom', onUpdate: (st) => { closeFade = Math.min(0.35, 0.1 + st.progress * 0.55); applyFade(); }, onLeaveBack: () => { closeFade = 0; applyFade(); } });

  /* photo reveals: GL planes on desktop, the DOM image elsewhere */
  const heroFigure = document.querySelector('.hero-fig');
  if (GL.planes.length) {
    GL.planes.forEach((p) => {
      if (p.fig === heroFigure) { gsap.delayedCall(0.55, p.want); return; }
      ScrollTrigger.create({ trigger: p.fig, start: 'top 92%', once: true, onEnter: p.want });
    });
  } else if (!reduced && !late) {
    document.querySelectorAll('.gl-fig img').forEach((img) => {
      gsap.set(img, { clipPath: 'inset(100% 0 0 0)', scale: 1.14 });
      const reveal = () => gsap.to(img, { clipPath: 'inset(0% 0 0 0)', scale: 1, duration: 1.7, ease: 'expo.out', overwrite: true });
      if (img.closest('.hero')) gsap.delayedCall(0.55, reveal);
      else ScrollTrigger.create({ trigger: img, start: 'top 92%', once: true, onEnter: reveal });
    });
  }

  /* depth: the figures drift against the page, which the GL planes pick up from the rect */
  if (!reduced) {
    document.querySelectorAll('.about-fig, .exp-fig').forEach((fig, i) => {
      gsap.fromTo(fig, { y: 26 + i * 4 }, { y: -26 - i * 4, ease: 'none',
        scrollTrigger: { trigger: fig, start: 'top bottom', end: 'bottom top', scrub: 0.6 } });
    });
  }

  /* nav: a solid backing once it sits over content (a plain scroll listener, so it also works with
     reduced motion, where the triggers below are removed and the bar never retracts) */
  const nav = document.getElementById('nav');
  const navSolid = () => nav.classList.toggle('is-solid', window.scrollY > 80);
  window.addEventListener('scroll', navSolid, { passive: true });
  navSolid();

  /* nav hides after 24px of scrolling down and comes back only after 160px up, so a small nudge does not flick it
     over the text. It stays put while it holds focus or while someone types in the form, and the y is clamped
     to the page, so the iPhone's bounce at either end does not count as scrolling up. */
  let navShown = true, navMark = 0;
  const setNav = (v) => { if (v === navShown) return; navShown = v; gsap.to(nav, { yPercent: v ? 0 : -140, duration: 0.35, ease: 'power2.out', overwrite: true }); };
  ScrollTrigger.create({
    start: 0, end: 'max',
    onUpdate: (st) => {
      const y = Math.min(Math.max(window.scrollY, 0), ScrollTrigger.maxScroll(window));
      const a = document.activeElement;
      if (y < 80 || nav.contains(a)) { setNav(true); navMark = y; return; }
      if (a && a.closest && a.closest('.field')) { navMark = y; return; }
      if (st.direction === 1) { if (y - navMark > 24) setNav(false); if (!navShown) navMark = y; }
      else { if (navMark - y > 160) setNav(true); if (navShown) navMark = y; }
    },
  });
  nav.addEventListener('focusin', () => setNav(true));

  /* text */
  document.querySelectorAll('[data-split]').forEach((el) => {
    if (el.closest('.hero, .arrive')) return;
    const words = el.querySelectorAll('.wi');
    ScrollTrigger.create({ trigger: el, start: 'top 85%', once: true, onEnter: () => gsap.to(words, { y: 0, duration: 1.3, ease: 'expo.out', stagger: 0.03, onComplete: () => el.classList.add('is-in') }) });
  });
  const lines = [...document.querySelectorAll('.reveal-line')].filter((el) => !el.closest('.hero'));
  ScrollTrigger.batch(lines, { start: 'top 90%', once: true, onEnter: (batch) => gsap.to(batch, { opacity: 1, y: 0, duration: 1.1, ease: 'expo.out', stagger: 0.08, overwrite: true }) });

  if (reduced) {
    ScrollTrigger.getAll().forEach((s) => s.kill());
    gsap.set('.wi, .reveal-line', { clearProps: 'all' });
    gsap.set('.arrive-copy', { opacity: 1, y: 0 });
  }
}

/* ---------- pointer tracking for the dust field ---------- */
function setupPointer() {
  if (!fine || reduced) return;
  window.addEventListener('pointermove', (e) => {
    /* no push over the form: specks should not scatter under the fields while someone types */
    if (e.target.closest && e.target.closest('#form')) GL.mouseT.set(9999, 9999);
    else GL.mouseT.set(e.clientX - W() / 2, -(e.clientY - H() / 2));
  }, { passive: true });
  document.addEventListener('pointerleave', () => GL.mouseT.set(9999, 9999));
}
function setupMagnetic() {
  if (!fine || reduced) return;
  document.querySelectorAll('[data-magnetic]').forEach((el) => {
    const xTo = gsap.quickTo(el, 'x', { duration: 0.6, ease: 'power3' }), yTo = gsap.quickTo(el, 'y', { duration: 0.6, ease: 'power3' });
    let cx = 0, cy = 0;
    /* the centre is measured once on entry, and the pull is a few pixels: the button leans, it does not run away */
    el.addEventListener('pointerenter', () => { const r = el.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; });
    el.addEventListener('pointermove', (e) => {
      xTo(gsap.utils.clamp(-8, 8, (e.clientX - cx) * 0.12)); yTo(gsap.utils.clamp(-4, 4, (e.clientY - cy) * 0.12));
    });
    el.addEventListener('pointerleave', () => { xTo(0); yTo(0); });
  });
}

/* ---------- "Pause motion": one switch for all background motion (WCAG 2.2.2), remembered for the next visit ---------- */
function setupMotionToggle() {
  const mt = document.getElementById('motion-toggle');
  if (!mt) return;
  const apply = (paused) => {
    GL.paused = paused;
    html.classList.toggle('motion-paused', paused);
    mt.textContent = paused ? 'Play motion' : 'Pause motion'; // the label names what the button will do
  };
  apply(GL.paused);
  mt.addEventListener('click', () => {
    apply(!GL.paused);
    try { localStorage.setItem('bf-motion', GL.paused ? 'paused' : 'on'); } catch (e) {}
  });
}

/* ---------- form ---------- */
/* Delivery. With this script running, the form goes out as JSON to FORM.endpoint. If this script never runs, the
   <form> in index.html posts itself to the same endpoint and Web3Forms sends the visitor to thanks.html.
   The access key and the sender name are in both files on purpose (this script must not depend on the HTML):
   change both together. The key is Bart's own (13 Nov 2026), so requests reach his inbox. */
const FORM = {
  endpoint: 'https://api.web3forms.com/submit',
  extra: { access_key: 'f86775f9-9d9f-4639-b0bb-601c3712e8e3' },
  fallbackEmail: 'bart.firch@gmail.com',
};

function setupForm() {
  const form = document.getElementById('form');
  const note = document.getElementById('form-note');
  const submit = document.getElementById('form-submit');
  const again = document.getElementById('form-again');
  const fields = [form.elements.name, form.elements.email, form.elements.message];
  const label = submit.textContent;

  /* each field has its own message line under it (aria-describedby in the HTML) */
  const problem = (f) => {
    const v = f.value.trim();
    if (f.name === 'name') return v ? '' : 'Add your name.';
    if (f.name === 'email') {
      if (!v) return 'Add your email so I can write back.';
      return /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v) ? '' : 'That email looks incomplete. It needs an @ and an ending, like name@example.com.';
    }
    return v ? '' : 'Add a line about what’s going on.';
  };
  const mark = (f) => {
    const msg = problem(f);
    const line = document.getElementById('e-' + f.id);
    if (line) { line.textContent = msg; line.hidden = !msg; }
    if (msg) f.setAttribute('aria-invalid', 'true'); else f.removeAttribute('aria-invalid');
    return !msg;
  };
  /* say() takes text or a list of text and nodes; never HTML, so nothing a visitor types can become markup */
  const say = (parts, isError) => {
    note.replaceChildren(...[].concat(parts));
    note.classList.toggle('is-error', !!isError);
  };
  const tally = () => {
    const n = fields.filter((f) => f.getAttribute('aria-invalid') === 'true').length;
    say(n === 0 ? '' : n === 1 ? 'One field needs a look.' : n + ' fields need a look.', n > 0);
  };
  /* a message goes away as soon as the field is fixed */
  fields.forEach((f) => f.addEventListener('input', () => { if (f.getAttribute('aria-invalid') === 'true') { mark(f); tally(); } }));

  /* sending failed: keep what they typed, and give the address as a link they can see */
  const failed = (data) => {
    const a = document.createElement('a');
    a.href = 'mailto:' + FORM.fallbackEmail + '?subject=' + encodeURIComponent('Consultation request from ' + data.name)
      + '&body=' + encodeURIComponent('Name: ' + data.name + '\nEmail: ' + data.email + '\n\n' + data.message);
    a.textContent = FORM.fallbackEmail;
    say(['That didn’t send, and it’s not you. Try again in a minute, or email me at ', a, '.'], true);
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault(); // first: the form has a real action, so a return above this line would post it natively
    if (form.classList.contains('is-sending')) return; // one send at a time (Enter in a field lands here too)
    if (form.elements.botcheck?.checked) return; // honeypot (?. because an HTML file cached from before this change has no botcheck)
    const bad = fields.filter((f) => !mark(f));
    if (bad.length) {
      tally();
      bad[0].focus({ preventScroll: true });
      /* bring the first wrong field to mid-screen, clear of the returning nav */
      if (lenis) lenis.scrollTo(bad[0], { offset: -innerHeight / 2 + 60, duration: 0.6 });
      else bad[0].scrollIntoView({ block: 'center' });
      return;
    }

    const data = {
      name: form.elements.name.value.trim(),
      email: form.elements.email.value.trim(),
      message: form.elements.message.value.trim(),
    };
    const first = data.name.split(' ')[0];

    form.classList.add('is-sending');
    submit.setAttribute('aria-disabled', 'true'); // not the disabled property: that would drop keyboard focus from the button
    submit.textContent = 'Sending…';
    say('Sending…');
    try {
      /* the body is built by hand: never serialise the form here, its hidden inputs belong to the no-script post */
      const res = await fetch(FORM.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(Object.assign({
          subject: 'Consultation request from ' + data.name,
          from_name: 'Bart Firch website',
        }, FORM.extra, data, { replyto: data.email })),
        signal: AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined, // a stalled connection ends in the message below, not a stuck form
      });
      /* delivered only when Web3Forms says so: a false thank-you loses an enquiry in silence */
      const out = await res.json().catch(() => null);
      if (!res.ok || !out || out.success !== true) throw new Error('HTTP ' + res.status);
      form.classList.add('is-sent');
      say('Thanks, ' + first + '. That came through, and I’ll reply to ' + data.email + '.');
      again.hidden = false;
      note.tabIndex = -1;
      note.focus();
    } catch (err) {
      failed(data);
    } finally {
      form.classList.remove('is-sending');
      submit.removeAttribute('aria-disabled');
      submit.textContent = label;
    }
  });
  /* typed the wrong address: the fields come back with their text, and Email takes focus */
  again.addEventListener('click', () => {
    form.classList.remove('is-sent');
    again.hidden = true;
    say('');
    form.elements.email.focus();
  });
  form.noValidate = true; // last: the browser's own validation guards the plain post until this handler is attached
}
