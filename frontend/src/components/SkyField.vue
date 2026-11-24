<template>
  <div class="sky" aria-hidden="true">
    <div class="sky-nebula n1"></div>
    <div class="sky-nebula n2"></div>
    <div class="sky-stars stars-a"></div>
    <div class="sky-stars stars-b"></div>
    <div class="sky-stars stars-c"></div>
    <div class="meteor meteor-a"></div>
    <div class="meteor meteor-b"></div>
    <div class="meteor meteor-c"></div>
  </div>
</template>

<!-- 星夜 sky — pure CSS, zero JS, zero assets.
     Layers (bottom → top): two drifting nebulae, three twinkling star
     layers (1px / 2px / 3px glow, drawn as box-shadow lists), three
     low-frequency meteors. Colors come from the --s1..--s5 / --neb* /
     --meteor-* tokens in style.css. Coordinates are hand-drawn in
     vw/vh so the sky scales with any viewport. Structure follows
     星野手帖 03-sky.css.
     Motion: prefers-reduced-motion freezes the twinkle, stops the
     nebulae and drops the meteors entirely. -->
<style scoped>
.sky {
  position: fixed;
  inset: 0;
  z-index: -1;
  overflow: hidden;
  pointer-events: none;
}

/* Sky rises with the app (one 500ms fade, paired with .app-shell's
   own reveal — the 进房首帧星幕亮起 moment lives here and there only). */
.sky {
  animation: sky-rise 0.5s ease-out both;
}

@keyframes sky-rise {
  from {
    opacity: 0;
  }
}

/* --- nebulae: two soft glows, drifting slowly ----------------------------- */

.sky-nebula {
  position: absolute;
  border-radius: 50%;
  will-change: transform;
}

.sky-nebula.n1 {
  top: -18%;
  right: -12%;
  width: 52vw;
  height: 52vw;
  background: radial-gradient(circle, var(--neb1) 0%, transparent 70%);
  animation: neb-drift-a 38s ease-in-out infinite alternate;
}

.sky-nebula.n2 {
  bottom: -22%;
  left: -14%;
  width: 58vw;
  height: 58vw;
  background: radial-gradient(circle, var(--neb2) 0%, transparent 70%);
  animation: neb-drift-b 52s ease-in-out infinite alternate;
}

@keyframes neb-drift-a {
  from {
    transform: translate(0, 0) scale(1);
  }

  to {
    transform: translate(-7vw, 5vh) scale(1.1);
  }
}

@keyframes neb-drift-b {
  from {
    transform: translate(0, 0) scale(1.06);
  }

  to {
    transform: translate(6vw, -4vh) scale(1);
  }
}

/* --- star layers: each div is one star pixel, the shadows are the rest --- */

.sky-stars {
  position: absolute;
  top: 0;
  left: 0;
  background: transparent;
  border-radius: 50%;
  animation: twinkle 5s ease-in-out infinite alternate;
}

.stars-a {
  width: 1px;
  height: 1px;
  animation-duration: 4.5s;
  box-shadow:
    55.31vw 50.56vh var(--s2),
    97.98vw 22.87vh var(--s1),
    77.13vw 93.66vh var(--s5),
    64.36vw 34.29vh var(--s1),
    9.40vw 2.13vh var(--s1),
    91.28vw 33.72vh var(--s1),
    50.10vw 43.12vh var(--s1),
    70.39vw 94.59vh var(--s1),
    58.82vw 5.84vh var(--s2),
    73.37vw 47.34vh var(--s1),
    12.34vw 77.46vh var(--s5),
    65.95vw 26.67vh var(--s4),
    76.56vw 1.96vh var(--s1),
    98.68vw 85.81vh var(--s1),
    47.41vw 41.71vh var(--s1),
    76.51vw 77.84vh var(--s1),
    18.18vw 19.61vh var(--s3),
    16.20vw 47.62vh var(--s1),
    91.15vw 87.29vh var(--s1),
    21.97vw 8.92vh var(--s2),
    30.10vw 7.43vh var(--s1),
    58.68vw 71.05vh var(--s1),
    72.30vw 96.10vh var(--s1),
    14.36vw 44.27vh var(--s4),
    93.53vw 18.61vh var(--s1),
    76.87vw 5.39vh var(--s2),
    30.31vw 69.06vh var(--s1),
    91.93vw 53.11vh var(--s4),
    3.89vw 73.51vh var(--s2),
    61.52vw 72.34vh var(--s1),
    18.18vw 59.46vh var(--s1),
    50.80vw 52.23vh var(--s1),
    70.77vw 15.74vh var(--s1),
    50.88vw 77.93vh var(--s1),
    48.02vw 76.24vh var(--s5),
    50.80vw 93.59vh var(--s2),
    35.66vw 72.98vh var(--s1),
    91.90vw 22.04vh var(--s5),
    4.93vw 67.64vh var(--s2),
    9.72vw 34.02vh var(--s2),
    10.34vw 34.23vh var(--s1),
    97.82vw 30.74vh var(--s4),
    77.18vw 79.94vh var(--s2),
    57.76vw 58.97vh var(--s3),
    5.44vw 19.63vh var(--s2),
    49.52vw 35.68vh var(--s4),
    96.76vw 3.39vh var(--s4),
    46.10vw 94.83vh var(--s3);
}

.stars-b {
  width: 2px;
  height: 2px;
  animation-duration: 7s;
  animation-delay: 1.2s;
  box-shadow:
    7.52vw 43.76vh var(--s5),
    50.73vw 77.71vh var(--s4),
    34.48vw 50.86vh var(--s3),
    24.94vw 98.32vh var(--s5),
    98.63vw 60.19vh var(--s3),
    70.91vw 4.07vh var(--s3),
    93.14vw 21.51vh var(--s1),
    81.95vw 80.94vh var(--s3),
    92.20vw 80.53vh var(--s2),
    35.71vw 24.29vh var(--s2),
    58.39vw 47.15vh var(--s3),
    80.67vw 12.09vh var(--s4),
    81.23vw 93.03vh var(--s2),
    16.01vw 71.16vh var(--s4),
    15.70vw 55.29vh var(--s3),
    78.03vw 39.80vh var(--s4),
    33.37vw 80.67vh var(--s2),
    12.85vw 58.25vh var(--s4),
    15.75vw 95.58vh var(--s3),
    11.31vw 63.20vh var(--s4),
    93.30vw 38.93vh var(--s4),
    63.67vw 36.66vh var(--s4),
    85.12vw 89.88vh var(--s2),
    62.22vw 11.26vh var(--s4),
    27.91vw 41.17vh var(--s2),
    80.85vw 89.98vh var(--s5),
    75.21vw 40.55vh var(--s5),
    88.70vw 45.19vh var(--s2),
    66.76vw 2.65vh var(--s3),
    62.21vw 8.13vh var(--s4);
}

.stars-c {
  width: 3px;
  height: 3px;
  animation-duration: 9.5s;
  animation-delay: 2.6s;
  box-shadow:
    84.94vw 3.35vh 2px var(--s5),
    16.07vw 42.83vh 2px var(--s3),
    24.70vw 15.26vh 2px var(--s3),
    62.18vw 95.85vh 2px var(--s2),
    78.44vw 55.38vh 2px var(--s2),
    94.08vw 63.85vh 2px var(--s2),
    34.91vw 53.96vh 2px var(--s2),
    82.49vw 31.42vh 2px var(--s1),
    11.54vw 93.38vh 2px var(--s1),
    97.71vw 75.44vh 2px var(--s5),
    14.38vw 79.14vh 2px var(--s2),
    74.79vw 51.40vh 2px var(--s3),
    47.31vw 62.73vh 2px var(--s2),
    32.81vw 36.45vh 2px var(--s3);
}

@keyframes twinkle {
  from {
    opacity: 0.45;
  }

  to {
    opacity: 1;
  }
}

/* --- meteors: long glowing streaks on three low-frequency orbits --------- */

.meteor {
  position: absolute;
  height: 2px;
  border-radius: 2px;
  background: var(--meteor-grad);
  opacity: 0;
  transform: rotate(var(--ma, -32deg));
  animation: meteor-fly 10s linear infinite;
}

.meteor::after {
  content: '';
  position: absolute;
  top: -1.4px;
  left: -1px;
  width: 4.5px;
  height: 4.5px;
  border-radius: 50%;
  background: var(--meteor-head);
  box-shadow: 0 0 12px 2px var(--meteor-head);
}

.meteor-a {
  top: 10%;
  left: 82%;
  width: 220px;
  animation-duration: 9s;
}

.meteor-b {
  top: 25%;
  left: 96%;
  width: 140px;
  animation-duration: 14s;
  animation-delay: 5s;
}

.meteor-c {
  --ma: -38deg;
  top: 5%;
  left: 60%;
  width: 180px;
  animation-duration: 19s;
  animation-delay: 11s;
}

@keyframes meteor-fly {
  0% {
    transform: rotate(var(--ma, -32deg)) translateX(6vw);
    opacity: 0;
  }

  2% {
    opacity: 1;
  }

  14% {
    transform: rotate(var(--ma, -32deg)) translateX(-82vw);
    opacity: 0;
  }

  100% {
    transform: rotate(var(--ma, -32deg)) translateX(-82vw);
    opacity: 0;
  }
}

/* --- calm: reduced motion freezes the sky, meteors drop out ---------------- */

@media (prefers-reduced-motion: reduce) {
  .sky {
    animation: none;
  }

  .sky-nebula,
  .sky-stars {
    animation: none;
  }

  .sky-stars {
    opacity: 0.72;
  }

  .meteor {
    display: none;
  }
}
</style>
