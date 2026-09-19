const canvas = document.getElementById('scene');
const ctx = canvas.getContext('2d');
const bouncesEl = document.getElementById('bounces');
const heightInput = document.getElementById('height');
const heightOut = document.getElementById('heightOut');
const dropBtn = document.getElementById('drop');

// ---- World (logical units, scaled to fit the window, anchored to the bottom) ----
const WORLD_W = 1000;
const WORLD_H = 700;
const GROUND_Y = 630;
const GRAVITY = 2000;
const BALL_R = 30;

// ---- Trampoline ----
const TRAMP_Y = 470;
const POST_L = 250;
const POST_R = 750;
const SPRING_LEN = 40;
const MAT_N = 48; // points used to draw the mat
const MAT_X0 = POST_L + SPRING_LEN;
const MAT_X1 = POST_R - SPRING_LEN;
const MAT_LEN = MAT_X1 - MAT_X0;

// The mat is a string described by a handful of standing waves (modes).
// While the ball is on it the mat is nearly massless, so its shape simply
// follows the ball and pushes back like a spring. Once the ball has left, the
// modes ring freely, which gives the wobble and ripples.
const MODES = 8;
const MAT_STIFFNESS = 150; // push-back per px of sag with the ball in the middle
const MODE_FREQ = 16; // rad/s that mode 1 rings at (mode k rings at k times this)
const MODE_DAMPING = 0.12; // per mode number, so ripples die out faster
const CONTACT_DAMPING = 0.5;
const CENTER_PUSH = 0.02; // off-centre balls get nudged towards the middle
const MAX_RELEASE_GAIN = 4; // >1 puts energy back in, like a person bouncing

// The ball is wide, so it presses on a patch rather than a point, which keeps
// the high modes from spiking under it.
const MODE_GRIP = [];
for (let k = 0; k < MODES; k++) {
  const spread = ((k + 1) * Math.PI * BALL_R * 1.5) / MAT_LEN;
  MODE_GRIP.push(Math.exp(-0.5 * spread * spread));
}

const STEP = 1 / 480;

const mat = { q: new Float64Array(MODES), v: new Float64Array(MODES), target: new Float64Array(MODES) };
const ball = { x: 0, y: 0, vx: 0, vy: 0, angle: 0, squash: 0, inContact: false, groundTime: 0 };

let bounces = 0;
let maxHeight = Number(heightInput.value);
let contactForce = 0;
let releaseGain = 1.25; // retuned after every bounce to reach the chosen height

// ---- Simulation ----

function drop(x, y) {
  const overTramp = x > POST_L && x < POST_R;
  ball.x = x;
  ball.y = overTramp
    ? Math.max(TRAMP_Y - BALL_R - 550, Math.min(y, TRAMP_Y - 100))
    : Math.min(y, GROUND_Y - BALL_R);
  ball.vx = (Math.random() - 0.5) * 60;
  ball.vy = 0;
  ball.groundTime = 0;
  ball.inContact = false;
}

function resetBall() {
  drop(WORLD_W / 2 + (Math.random() - 0.5) * 40, 100);
}

// Mode amplitudes of a string pulled down by `sag` at position u (0..1).
function fitMat(u, sag, out) {
  if (u <= 0 || u >= 1) {
    out.fill(0);
    return;
  }
  let reach = 0;
  for (let k = 0; k < MODES; k++) {
    const s = Math.sin((k + 1) * Math.PI * u);
    out[k] = (MODE_GRIP[k] * s) / ((k + 1) * (k + 1));
    reach += out[k] * s;
  }
  const scale = reach > 1e-6 ? sag / reach : 0;
  for (let k = 0; k < MODES; k++) out[k] *= scale;
}

// Compare how high the ball is about to fly with the chosen height and nudge
// the release strength so the next bounce lands closer to it.
function retuneRelease() {
  const rise = (ball.vy * ball.vy) / (2 * GRAVITY);
  const wanted = ball.y - (TRAMP_Y - BALL_R - maxHeight);
  if (rise < 1 || wanted <= 0) return;
  const ratio = Math.min(Math.max(wanted / rise, 0.5), 2);
  releaseGain = Math.min(Math.max(releaseGain * Math.pow(ratio, 0.7), 1), MAX_RELEASE_GAIN);
}

function step(dt) {
  contactForce = 0;
  ball.vy += GRAVITY * dt;

  // Ball vs. trampoline
  const wasInContact = ball.inContact;
  const sag = ball.y + BALL_R - TRAMP_Y; // how far the ball's bottom is below the mat's rest line
  const overFrame = ball.x > POST_L && ball.x < POST_R;
  ball.inContact = overFrame && sag > 0 && (wasInContact || ball.y < TRAMP_Y);

  if (ball.inContact) {
    const u = (ball.x - MAT_X0) / MAT_LEN;
    const edge = Math.min(Math.max(u, 0.1), 0.9);
    const stiffness = (MAT_STIFFNESS * 0.25) / (edge * (1 - edge)); // stiffer near the edges

    let force = stiffness * sag;
    if (ball.vy > 0) force += CONTACT_DAMPING * ball.vy;
    else force *= releaseGain;

    ball.vy -= force * dt;
    ball.vx *= 1 - 2 * dt; // the mat grips the ball a little
    ball.vx += force * CENTER_PUSH * ((MAT_X0 + MAT_X1) / 2 - ball.x) / (MAT_LEN / 2) * dt;
    contactForce = force;

    if (!wasInContact && ball.vy > 200) {
      bounces++;
      bouncesEl.textContent = bounces;
    }

    // The mat snaps to the shape the ball is pressing into it.
    fitMat(u, sag, mat.target);
    const blend = 1 - Math.exp(-dt * 400);
    for (let k = 0; k < MODES; k++) {
      const next = mat.q[k] + (mat.target[k] - mat.q[k]) * blend;
      mat.v[k] = (next - mat.q[k]) / dt;
      mat.q[k] = next;
    }
  } else {
    if (wasInContact && ball.vy < 0) retuneRelease();

    // Free ringing
    for (let k = 0; k < MODES; k++) {
      const w = MODE_FREQ * (k + 1);
      const damping = 2 * MODE_DAMPING * (k + 1) * w;
      mat.v[k] += (-w * w * mat.q[k] - damping * mat.v[k]) * dt;
      mat.q[k] += mat.v[k] * dt;
    }
  }

  // Keep the bounce from going higher than the chosen height.
  if (!ball.inContact && ball.vy < 0) {
    const room = ball.y - (TRAMP_Y - BALL_R - maxHeight);
    if (room <= 0) ball.vy = 0;
    else ball.vy = Math.max(ball.vy, -Math.sqrt(2 * GRAVITY * room));
  }

  // Integrate the ball
  ball.x += ball.vx * dt;
  ball.y += ball.vy * dt;
  ball.vx *= 1 - 0.15 * dt;
  ball.angle += (ball.vx / BALL_R) * dt;

  // Ground
  if (ball.y + BALL_R > GROUND_Y) {
    ball.y = GROUND_Y - BALL_R;
    ball.vy = Math.abs(ball.vy) < 60 ? 0 : -ball.vy * 0.45;
    ball.vx *= 1 - 3 * dt;
  }

  // Screen edges
  if (ball.x < view.left + BALL_R) {
    ball.x = view.left + BALL_R;
    ball.vx = Math.abs(ball.vx) * 0.6;
  } else if (ball.x > view.right - BALL_R) {
    ball.x = view.right - BALL_R;
    ball.vx = -Math.abs(ball.vx) * 0.6;
  }

  // Ball came to rest on the ground (missed the trampoline): put it back.
  const resting = ball.y + BALL_R >= GROUND_Y - 0.5 && Math.abs(ball.vy) < 1;
  ball.groundTime = resting ? ball.groundTime + dt : 0;
  if (ball.groundTime > 1.5) resetBall();

  // Squash on impact, stretch in the air
  const target = ball.inContact
    ? Math.min(contactForce / 20000, 1) * 0.3
    : -Math.min(Math.abs(ball.vy) / 6000, 0.12);
  ball.squash += (target - ball.squash) * Math.min(1, dt * 40);
}

// ---- View ----

const view = { w: 0, h: 0, dpr: 1, scale: 1, offsetX: 0, offsetY: 0, left: 0, right: WORLD_W, top: 0 };

function resize() {
  view.dpr = window.devicePixelRatio || 1;
  view.w = window.innerWidth;
  view.h = window.innerHeight;
  canvas.width = Math.round(view.w * view.dpr);
  canvas.height = Math.round(view.h * view.dpr);

  view.scale = Math.min(view.w / WORLD_W, view.h / WORLD_H);
  view.offsetX = (view.w - WORLD_W * view.scale) / 2;
  view.offsetY = view.h - WORLD_H * view.scale;
  view.left = -view.offsetX / view.scale;
  view.right = (view.w - view.offsetX) / view.scale;
  view.top = -view.offsetY / view.scale;

  // Don't let the slider go past the top of the screen.
  const room = Math.floor((TRAMP_Y - BALL_R - view.top - 20) / 10) * 10;
  heightInput.max = Math.max(150, Math.min(500, room));
  maxHeight = Number(heightInput.value);
  heightOut.textContent = maxHeight;
}

function toWorld(clientX, clientY) {
  return {
    x: (clientX - view.offsetX) / view.scale,
    y: (clientY - view.offsetY) / view.scale,
  };
}

// ---- Drawing ----

const clouds = [
  { x: 0.1, y: 0.12, s: 1.0, speed: 6 },
  { x: 0.5, y: 0.22, s: 0.7, speed: 4 },
  { x: 0.8, y: 0.08, s: 1.3, speed: 8 },
];

function drawSky(time) {
  const sky = ctx.createLinearGradient(0, 0, 0, view.h);
  sky.addColorStop(0, '#5db7f5');
  sky.addColorStop(1, '#cdeeff');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, view.w, view.h);

  ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
  for (const c of clouds) {
    const span = view.w + 300;
    const x = ((c.x * view.w + time * c.speed) % span) - 150;
    const y = c.y * view.h;
    const r = 28 * c.s;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.arc(x + r * 1.1, y - r * 0.4, r * 1.2, 0, Math.PI * 2);
    ctx.arc(x + r * 2.3, y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawGround() {
  ctx.fillStyle = '#6a4a2f';
  ctx.fillRect(view.left - 50, GROUND_Y, view.right - view.left + 100, WORLD_H - GROUND_Y + 200);
  ctx.fillStyle = '#4fae4a';
  ctx.fillRect(view.left - 50, GROUND_Y, view.right - view.left + 100, 14);
}

function drawShadow() {
  const height = Math.max(0, GROUND_Y - (ball.y + BALL_R));
  const k = Math.max(0.35, 1 - height / 900);
  ctx.fillStyle = `rgba(0, 0, 0, ${0.22 * k})`;
  ctx.beginPath();
  ctx.ellipse(ball.x, GROUND_Y + 8, BALL_R * 1.3 * k, 7 * k, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawSpring(x0, x1, y) {
  const coils = 7;
  ctx.beginPath();
  ctx.moveTo(x0, y);
  for (let i = 0; i < coils; i++) {
    const x = x0 + ((i + 0.5) / coils) * (x1 - x0);
    ctx.lineTo(x, y + (i % 2 ? 8 : -8));
  }
  ctx.lineTo(x1, y);
  ctx.strokeStyle = '#9aa3ad';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawTrampoline() {
  // Legs and posts
  ctx.strokeStyle = '#48525e';
  ctx.lineCap = 'round';
  ctx.lineWidth = 12;
  for (const x of [POST_L, POST_R]) {
    ctx.beginPath();
    ctx.moveTo(x, TRAMP_Y);
    ctx.lineTo(x, GROUND_Y);
    ctx.stroke();
  }
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.moveTo(POST_L, GROUND_Y - 30);
  ctx.lineTo(POST_R, GROUND_Y - 30);
  ctx.stroke();

  // Edge springs
  drawSpring(POST_L, MAT_X0, TRAMP_Y);
  drawSpring(MAT_X1, POST_R, TRAMP_Y);

  // Mat (top edge sits on the surface the ball touches)
  ctx.beginPath();
  for (let i = 0; i < MAT_N; i++) {
    const u = i / (MAT_N - 1);
    const x = MAT_X0 + u * MAT_LEN;
    let d = 0;
    for (let k = 0; k < MODES; k++) d += mat.q[k] * Math.sin((k + 1) * Math.PI * u);
    const y = TRAMP_Y + d + 5;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = '#25408f';
  ctx.lineWidth = 12;
  ctx.stroke();
  ctx.strokeStyle = '#4f7be0';
  ctx.lineWidth = 3;
  ctx.translate(0, -3);
  ctx.stroke();
  ctx.translate(0, 3);

  // Post caps
  ctx.fillStyle = '#e8642c';
  for (const x of [POST_L, POST_R]) {
    ctx.beginPath();
    ctx.arc(x, TRAMP_Y, 11, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBall() {
  const sy = 1 - ball.squash;
  const sx = 1 / Math.sqrt(sy);

  ctx.save();
  ctx.translate(ball.x, ball.y + BALL_R); // squash from the bottom of the ball
  ctx.scale(sx, sy);
  ctx.translate(0, -BALL_R);
  ctx.rotate(ball.angle);

  const shade = ctx.createRadialGradient(-BALL_R * 0.35, -BALL_R * 0.4, BALL_R * 0.1, 0, 0, BALL_R);
  shade.addColorStop(0, '#ffab6b');
  shade.addColorStop(1, '#d9531a');
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
  ctx.fill();

  // Basketball seams
  ctx.strokeStyle = '#3a1a0a';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(-BALL_R, 0);
  ctx.lineTo(BALL_R, 0);
  ctx.moveTo(0, -BALL_R);
  ctx.lineTo(0, BALL_R);
  ctx.stroke();
  for (const dir of [-1, 1]) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, BALL_R, 0, Math.PI * 2);
    ctx.clip();
    ctx.beginPath();
    ctx.arc(dir * BALL_R * 1.15, 0, BALL_R * 0.85, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  ctx.restore();
}

function render(time) {
  ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
  drawSky(time);

  ctx.translate(view.offsetX, view.offsetY);
  ctx.scale(view.scale, view.scale);
  drawGround();
  drawShadow();
  drawTrampoline();
  drawBall();
}

// ---- Wiring ----

heightInput.addEventListener('input', () => {
  maxHeight = Number(heightInput.value);
  heightOut.textContent = maxHeight;
});

dropBtn.addEventListener('click', () => {
  dropBtn.blur();
  resetBall();
});

canvas.addEventListener('pointerdown', (e) => {
  const p = toWorld(e.clientX, e.clientY);
  drop(p.x, p.y);
});

window.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    resetBall();
  }
});

window.addEventListener('resize', resize);

let last = performance.now();
let accumulator = 0;

function frame(now) {
  accumulator += Math.min((now - last) / 1000, 0.05);
  last = now;
  while (accumulator >= STEP) {
    step(STEP);
    accumulator -= STEP;
  }
  render(now / 1000);
  requestAnimationFrame(frame);
}

resize();
resetBall();
requestAnimationFrame(frame);
