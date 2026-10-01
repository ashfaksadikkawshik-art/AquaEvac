/**
 * =============================================================================
 * AquaEvac — Universal Dynamic Flood Rescue & Thunderstorm Animation
 * =============================================================================
 * Self-initializing full-screen animated background:
 *   - Dark stormy atmosphere with drifting procedural clouds
 *   - Periodic & interactive lightning strikes with ambient sky/water flash
 *   - Wind-driven falling rain with surface ripples & splash physics
 *   - Multi-layered surging floodwaters with floating debris & foam crests
 *   - Submerged house rooftop with 3 stranded flood victims (SOS waving flare)
 *   - Emergency Rescue Boat mission sequence:
 *       1. APPROACH: Boat cruises across floodwaters with searchlight beam
 *       2. DOCK: Boat pulls alongside submerged rooftop
 *       3. RESCUE: Survivors board boat safely one by one
 *       4. EVACUATE: Boat accelerates safely towards emergency shelter
 *       5. PATROL / LOOP: Continuous atmospheric rescue cycle
 *   - Web Audio API synthesizer for realistic ambient rain & thunder (optional toggle)
 *   - Works universally across ALL pages without breaking any layout!
 * =============================================================================
 */

(function () {
  'use strict';

  // Prevent multiple instances
  if (window.__AquaEvacFloodScene) return;

  class AquaEvacFloodScene {
    constructor() {
      this.initCanvas();
      this.initParameters();
      this.initParticles();
      this.buildFloatingControls();

      this.lastTime = performance.now();
      this.loop = this.loop.bind(this);
      this.handleResize = this.handleResize.bind(this);

      window.addEventListener('resize', this.handleResize);
      this.handleResize();

      requestAnimationFrame(this.loop);
    }

    drawRoundedRect(ctx, x, y, width, height, radius) {
      if (typeof ctx.roundRect === 'function') {
        ctx.beginPath();
        ctx.roundRect(x, y, width, height, radius);
        return;
      }
      const r = Math.min(radius, width / 2, height / 2);
      ctx.beginPath();
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + width - r, y);
      ctx.quadraticCurveTo(x + width, y, x + width, y + r);
      ctx.lineTo(x + width, y + height - r);
      ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
      ctx.lineTo(x + r, y + height);
      ctx.quadraticCurveTo(x, y + height, x, y + height - r);
      ctx.lineTo(x, y + r);
      ctx.quadraticCurveTo(x, y, x + r, y);
      ctx.closePath();
    }

    initCanvas() {
      // Create a fixed full-screen canvas behind all page content
      let canvas = document.getElementById('aquaevac-flood-canvas');
      this.isDashboard = !!document.getElementById('map');

      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.id = 'aquaevac-flood-canvas';
        canvas.setAttribute('aria-hidden', 'true');
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        canvas.style.width = '100vw';
        canvas.style.height = '100vh';
        canvas.style.pointerEvents = 'none';
        canvas.style.zIndex = this.isDashboard ? '450' : '1';
        canvas.style.display = 'block';

        // Insert at the very beginning of body
        if (document.body) {
          document.body.insertBefore(canvas, document.body.firstChild);
        } else {
          document.addEventListener('DOMContentLoaded', () => {
            document.body.insertBefore(canvas, document.body.firstChild);
          });
        }
      }

      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.dpr = Math.min(window.devicePixelRatio || 1, 2);

      // On non-dashboard pages, ensure body and html background does not occlude canvas
      if (!this.isDashboard) {
        if (document.documentElement) document.documentElement.style.backgroundColor = '#0c1829';
        if (document.body) document.body.style.backgroundColor = 'transparent';
      }
    }

    initParameters() {
      this.width = window.innerWidth || 1200;
      this.height = window.innerHeight || 800;

      this.animTime = 0;
      this.waterBaseY = this.isDashboard ? this.height - 85 : Math.round(this.height * 0.63);

      // Storm & Lightning (triggers first strike immediately at 0.5s so user sees it right away)
      this.lightning = {
        active: false,
        flashAlpha: 0,
        bolts: [],
        nextStrike: 0.5,
      };

      // Rescue Mission State Machine
      // 'APPROACH' -> 'DOCKING' -> 'BOARDING' -> 'DEPARTING' -> 'RESET'
      this.missionState = 'APPROACH';
      this.survivorsOnRoof = 3;
      this.survivorsOnBoat = 0;
      this.boatX = Math.round(this.width * 0.15); // Already visible cruising in on page load
      this.boatY = this.waterBaseY;
      this.boatSpeed = 2.4;
      this.boatAngle = 0;
      this.stateTimer = 0;

      // Position of submerged rooftop (always prominently placed)
      this.roofX = this.isDashboard ? Math.max(this.width * 0.82, 420) : (this.width > 768 ? Math.round(this.width * 0.70) : Math.round(this.width * 0.74));
      this.roofY = this.waterBaseY + 12;

      this.missionMessage = '🚨 EMERGENCY SOS: CITIZENS STRANDED BY FLOODWATERS — RESCUE 01 RESPONDING';

      // Audio state
      this.audioCtx = null;
      this.audioEnabled = false;
      this.rainGain = null;
      this.rainSource = null;
    }

    initParticles() {
      // Clouds
      this.clouds = [];
      const cloudCount = Math.max(6, Math.floor(this.width / 200));
      for (let i = 0; i < cloudCount; i++) {
        this.clouds.push({
          x: Math.random() * (this.width + 400) - 200,
          y: 20 + Math.random() * 110,
          speed: 0.18 + Math.random() * 0.28,
          scale: 0.85 + Math.random() * 0.75,
          alpha: 0.45 + Math.random() * 0.35,
          color: i % 2 === 0 ? '#132135' : '#0a1424'
        });
      }

      // Rain
      this.raindrops = [];
      this.maxRaindrops = Math.min(380, Math.floor(this.width / 3.8));
      for (let i = 0; i < this.maxRaindrops; i++) {
        this.raindrops.push({
          x: Math.random() * (this.width + 400) - 200,
          y: Math.random() * this.height,
          speed: 18 + Math.random() * 12,
          length: 20 + Math.random() * 18,
          thickness: 0.9 + Math.random() * 1.3,
          alpha: 0.25 + Math.random() * 0.45,
        });
      }

      // Water ripples & splashes
      this.ripples = [];
      this.splashes = [];
    }

    handleResize() {
      this.width = window.innerWidth || 1200;
      this.height = window.innerHeight || 800;

      this.canvas.width = this.width * this.dpr;
      this.canvas.height = this.height * this.dpr;
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

      this.isDashboard = !!document.getElementById('map');
      this.waterBaseY = this.isDashboard ? this.height - 85 : Math.round(this.height * 0.63);
      this.roofX = this.isDashboard ? Math.max(this.width * 0.82, 420) : (this.width > 768 ? Math.round(this.width * 0.70) : Math.round(this.width * 0.74));
      this.roofY = this.waterBaseY + 12;
    }

    getWaterSurfaceY(x, t) {
      const w1 = Math.sin(x * 0.006 + t * 2.2) * 8;
      const w2 = Math.cos(x * 0.014 - t * 1.6) * 5;
      const w3 = Math.sin(x * 0.028 + t * 3.0) * 3;
      return this.waterBaseY + w1 + w2 + w3;
    }

    triggerLightning() {
      this.lightning.active = true;
      this.lightning.flashAlpha = 0.95;
      this.lightning.nextStrike = 3.5 + Math.random() * 3.5;

      // Generate realistic branching bolt paths
      this.lightning.bolts = [];
      const startX = this.width * 0.15 + Math.random() * (this.width * 0.7);
      let currX = startX;
      let currY = 0;
      const targetY = this.waterBaseY - 20;

      const mainBolt = [{ x: currX, y: currY }];
      while (currY < targetY) {
        currY += 22 + Math.random() * 26;
        currX += (Math.random() - 0.48) * 45;
        mainBolt.push({ x: currX, y: currY });

        // Branching forks
        if (Math.random() < 0.38 && mainBolt.length > 2) {
          const branch = [{ x: currX, y: currY }];
          let bx = currX;
          let by = currY;
          for (let b = 0; b < 4; b++) {
            by += 16 + Math.random() * 20;
            bx += (Math.random() - 0.5) * 36;
            branch.push({ x: bx, y: by });
          }
          this.lightning.bolts.push(branch);
        }
      }
      this.lightning.bolts.unshift(mainBolt);

      if (this.audioEnabled) {
        this.playThunderSound();
      }
    }

    updateRain(dt) {
      const windDrift = 5.2;

      for (let i = 0; i < this.raindrops.length; i++) {
        const drop = this.raindrops[i];
        drop.x -= windDrift * (drop.speed / 20);
        drop.y += drop.speed;

        const surfaceY = this.getWaterSurfaceY(drop.x, this.animTime);

        if (drop.y >= surfaceY) {
          // Splash into floodwater
          if (Math.random() < 0.5) {
            this.ripples.push({
              x: drop.x,
              y: surfaceY,
              rx: 2,
              ry: 1,
              maxRadius: 10 + Math.random() * 12,
              alpha: 0.6,
            });
          }
          if (Math.random() < 0.22) {
            this.splashes.push({
              x: drop.x,
              y: surfaceY,
              vx: (Math.random() - 0.5) * 2.2,
              vy: -2.2 - Math.random() * 2.2,
              alpha: 0.8,
            });
          }

          // Reset raindrop to top
          drop.y = -25;
          drop.x = Math.random() * (this.width + 400) - 200;
        }
      }

      // Update ripples
      for (let r = this.ripples.length - 1; r >= 0; r--) {
        const rip = this.ripples[r];
        rip.rx += 0.65;
        rip.ry += 0.28;
        rip.alpha -= 0.026;
        if (rip.alpha <= 0 || rip.rx >= rip.maxRadius) {
          this.ripples.splice(r, 1);
        }
      }

      // Update splashes
      for (let s = this.splashes.length - 1; s >= 0; s--) {
        const sp = this.splashes[s];
        sp.x += sp.vx;
        sp.y += sp.vy;
        sp.vy += 0.22;
        sp.alpha -= 0.045;
        if (sp.alpha <= 0) {
          this.splashes.splice(s, 1);
        }
      }
    }

    updateMission(dt) {
      this.stateTimer += dt;
      const targetX = this.roofX - 85;

      switch (this.missionState) {
        case 'APPROACH':
          this.missionMessage = '🚨 EMERGENCY SOS: CITIZENS STRANDED BY FLOODWATERS — RESCUE 01 RESPONDING';
          this.survivorsOnRoof = 3;
          this.survivorsOnBoat = 0;
          this.boatX += this.boatSpeed;
          this.boatSpeed = Math.min(this.boatSpeed + 0.02, 2.8);

          if (this.boatX >= targetX - 110) {
            this.missionState = 'DOCKING';
            this.stateTimer = 0;
          }
          break;

        case 'DOCKING':
          this.missionMessage = '⚓ RESCUE BOAT DOCKING ALONGSIDE SUBMERGED ROOFTOP...';
          const dist = targetX - this.boatX;
          this.boatX += dist * 0.045;

          if (this.stateTimer > 2.0) {
            this.missionState = 'BOARDING';
            this.stateTimer = 0;
          }
          break;

        case 'BOARDING':
          this.missionMessage = '🤝 RESCUE CREW ASSISTING CITIZENS SAFELY ONTO THE RESCUE CRAFT...';
          if (this.stateTimer > 1.2 && this.survivorsOnRoof === 3) {
            this.survivorsOnRoof = 2;
            this.survivorsOnBoat = 1;
          } else if (this.stateTimer > 2.4 && this.survivorsOnRoof === 2) {
            this.survivorsOnRoof = 1;
            this.survivorsOnBoat = 2;
          } else if (this.stateTimer > 3.6 && this.survivorsOnRoof === 1) {
            this.survivorsOnRoof = 0;
            this.survivorsOnBoat = 3;
          }

          if (this.stateTimer > 5.0) {
            this.missionState = 'DEPARTING';
            this.stateTimer = 0;
          }
          break;

        case 'DEPARTING':
          this.missionMessage = '✅ ALL SURVIVORS SECURED ONBOARD! NAVIGATING SAFE ROUTE TO EMERGENCY SHELTER 🟢';
          this.boatSpeed = Math.min(this.boatSpeed + 0.045, 4.0);
          this.boatX += this.boatSpeed;

          if (this.boatX > this.width + 200) {
            this.missionState = 'RESET';
            this.stateTimer = 0;
          }
          break;

        case 'RESET':
          this.missionMessage = '🔍 PATROLLING HIGH-RISK FLOOD ZONES...';
          if (this.stateTimer > 2.5) {
            this.boatX = -180;
            this.boatSpeed = 2.4;
            this.survivorsOnRoof = 3;
            this.survivorsOnBoat = 0;
            this.missionState = 'APPROACH';
            this.stateTimer = 0;
          }
          break;
      }

      // Boat vertical bobbing
      const waterY = this.getWaterSurfaceY(this.boatX + 45, this.animTime);
      const nextWaterY = this.getWaterSurfaceY(this.boatX + 60, this.animTime);
      this.boatY = waterY - 8;
      this.boatAngle = Math.atan2(nextWaterY - waterY, 15) * 0.8;
    }

    renderSky() {
      const ctx = this.ctx;

      if (this.isDashboard) {
        ctx.fillStyle = 'rgba(10, 19, 34, 0.04)';
        ctx.fillRect(0, 0, this.width, this.height);
        return;
      }

      // Storm Sky Gradient (Rich visible deep slate & navy, not pure black)
      const skyGrad = ctx.createLinearGradient(0, 0, 0, this.waterBaseY);
      skyGrad.addColorStop(0, '#0a1626');
      skyGrad.addColorStop(0.35, '#12263d');
      skyGrad.addColorStop(0.70, '#1c395a');
      skyGrad.addColorStop(1, '#254a73');
      ctx.fillStyle = skyGrad;
      ctx.fillRect(0, 0, this.width, this.height);

      // Distant horizon silhouettes (flooded hills & trees)
      ctx.fillStyle = '#091523';
      ctx.beginPath();
      ctx.moveTo(0, this.waterBaseY);
      for (let x = 0; x <= this.width; x += 35) {
        const hillY = this.waterBaseY - 20 + Math.sin(x * 0.005) * 10 + Math.cos(x * 0.012) * 6;
        ctx.lineTo(x, hillY);
      }
      ctx.lineTo(this.width, this.waterBaseY);
      ctx.fill();

      // Distant flooded electric transmission towers
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)';
      ctx.lineWidth = 1.5;
      for (let px = 90; px < this.width; px += 260) {
        const py = this.waterBaseY - 18;
        ctx.beginPath();
        ctx.moveTo(px, py);
        ctx.lineTo(px, py - 50);
        ctx.moveTo(px - 14, py - 40);
        ctx.lineTo(px + 14, py - 40);
        ctx.moveTo(px - 10, py - 24);
        ctx.lineTo(px + 10, py - 24);
        ctx.stroke();
      }
    }

    renderClouds() {
      const ctx = this.ctx;
      for (const cloud of this.clouds) {
        cloud.x += cloud.speed;
        if (cloud.x > this.width + 250) cloud.x = -250;

        ctx.save();
        ctx.fillStyle = cloud.color;
        ctx.globalAlpha = cloud.alpha;
        ctx.beginPath();
        const cx = cloud.x;
        const cy = cloud.y;
        const s = cloud.scale;

        ctx.arc(cx, cy, 48 * s, 0, Math.PI * 2);
        ctx.arc(cx + 42 * s, cy - 16 * s, 58 * s, 0, Math.PI * 2);
        ctx.arc(cx + 90 * s, cy, 52 * s, 0, Math.PI * 2);
        ctx.arc(cx + 138 * s, cy + 12 * s, 42 * s, 0, Math.PI * 2);
        ctx.arc(cx + 48 * s, cy + 22 * s, 48 * s, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    }

    renderLightning() {
      const ctx = this.ctx;

      if (this.lightning.flashAlpha > 0.01) {
        // Dramatic ambient sky & water flash
        ctx.save();
        ctx.fillStyle = `rgba(224, 238, 255, ${this.lightning.flashAlpha * 0.55})`;
        ctx.fillRect(0, 0, this.width, this.height);
        ctx.restore();

        // Branching electric blue-white bolts
        ctx.save();
        ctx.lineWidth = 2.8;
        ctx.strokeStyle = `rgba(255, 255, 255, ${this.lightning.flashAlpha * 0.95})`;
        ctx.shadowColor = '#60a5fa';
        ctx.shadowBlur = 22;

        for (const bolt of this.lightning.bolts) {
          if (bolt.length < 2) continue;
          ctx.beginPath();
          ctx.moveTo(bolt[0].x, bolt[0].y);
          for (let i = 1; i < bolt.length; i++) {
            ctx.lineTo(bolt[i].x, bolt[i].y);
          }
          ctx.stroke();
        }
        ctx.restore();
      }
    }

    renderSubmergedRooftop() {
      const ctx = this.ctx;
      const rx = this.roofX;
      const ry = this.roofY;

      ctx.save();

      // House Attic / Wall emerging from flood
      ctx.fillStyle = '#334155';
      ctx.beginPath();
      ctx.moveTo(rx - 70, ry + 40);
      ctx.lineTo(rx - 70, ry - 15);
      ctx.lineTo(rx + 70, ry - 15);
      ctx.lineTo(rx + 70, ry + 40);
      ctx.fill();

      // Submerged water line marker
      ctx.strokeStyle = 'rgba(15, 23, 42, 0.45)';
      ctx.lineWidth = 1;
      for (let l = ry - 10; l < ry + 40; l += 9) {
        ctx.beginPath();
        ctx.moveTo(rx - 70, l);
        ctx.lineTo(rx + 70, l);
        ctx.stroke();
      }

      // Roof Triangular Structure (Terracotta roof)
      ctx.fillStyle = '#b45309';
      ctx.beginPath();
      ctx.moveTo(rx - 85, ry - 15);
      ctx.lineTo(rx, ry - 58);
      ctx.lineTo(rx + 85, ry - 15);
      ctx.closePath();
      ctx.fill();

      // Roof Ridges
      ctx.strokeStyle = '#78350f';
      ctx.lineWidth = 2;
      for (let r = -70; r <= 70; r += 20) {
        ctx.beginPath();
        ctx.moveTo(rx + r, ry - 15);
        ctx.lineTo(rx, ry - 58);
        ctx.stroke();
      }

      // Chimney
      ctx.fillStyle = '#475569';
      ctx.fillRect(rx - 46, ry - 68, 15, 28);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(rx - 48, ry - 70, 19, 5);

      // Sandbags on roof edge
      ctx.fillStyle = '#ca8a04';
      for (let s = -60; s <= 60; s += 24) {
        ctx.beginPath();
        ctx.ellipse(rx + s, ry - 13, 11, 6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }

      // Water danger level gauge pole
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(rx + 68, ry - 42);
      ctx.lineTo(rx + 68, ry + 45);
      ctx.stroke();
      // Danger marker
      ctx.fillStyle = '#dc2626';
      ctx.beginPath();
      ctx.arc(rx + 68, ry - 44, 4, 0, Math.PI * 2);
      ctx.fill();

      // Stranded people on the roof
      this.renderSurvivors(rx, ry);

      ctx.restore();
    }

    renderSurvivors(rx, ry) {
      const ctx = this.ctx;
      const count = this.survivorsOnRoof;
      if (count === 0) return;

      const t = this.animTime;

      // 1. Adult waving SOS Emergency Flare / Torch
      if (count >= 1) {
        const ax = rx - 10;
        const ay = ry - 58;

        // Legs & Body
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(ax - 4, ay - 18, 8, 20);

        // Emergency Orange Rain Jacket
        ctx.fillStyle = '#ea580c';
        ctx.fillRect(ax - 5, ay - 32, 10, 15);

        // Head
        ctx.fillStyle = '#fed7aa';
        ctx.beginPath();
        ctx.arc(ax, ay - 37, 5, 0, Math.PI * 2);
        ctx.fill();

        // Waving Arm with Flare
        const waveAngle = Math.sin(t * 7) * 0.45 - 0.7;
        ctx.save();
        ctx.translate(ax + 3, ay - 28);
        ctx.rotate(waveAngle);

        ctx.strokeStyle = '#ea580c';
        ctx.lineWidth = 3.5;
        ctx.beginPath();
        ctx.moveTo(0, 0);
        ctx.lineTo(14, -10);
        ctx.stroke();

        // Glowing Flare Core
        const flareAlpha = 0.65 + Math.sin(t * 12) * 0.35;
        ctx.fillStyle = `rgba(251, 146, 60, ${flareAlpha})`;
        ctx.beginPath();
        ctx.arc(14, -10, 7.5, 0, Math.PI * 2);
        ctx.fill();

        // Warm flare light beam into the dark sky
        const lightGrad = ctx.createRadialGradient(14, -10, 4, 14 - 90, -10 - 110, 180);
        lightGrad.addColorStop(0, 'rgba(253, 224, 71, 0.55)');
        lightGrad.addColorStop(1, 'rgba(253, 224, 71, 0)');
        ctx.fillStyle = lightGrad;
        ctx.beginPath();
        ctx.moveTo(14, -10);
        ctx.lineTo(14 - 130, -10 - 140);
        ctx.lineTo(14 - 40, -10 - 170);
        ctx.closePath();
        ctx.fill();

        ctx.restore();

        // Floating SOS text badge
        const sosPulse = Math.sin(t * 5) > 0;
        ctx.fillStyle = sosPulse ? '#dc2626' : '#f97316';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'center';
        ctx.fillText('SOS · RESCUE US!', ax, ay - 52);
      }

      // 2. Second Adult
      if (count >= 2) {
        const bx = rx + 18;
        const by = ry - 44;

        ctx.fillStyle = '#1e293b';
        ctx.fillRect(bx - 4, by - 14, 8, 16);
        ctx.fillStyle = '#3b82f6'; // blue jacket
        ctx.fillRect(bx - 5, by - 26, 10, 13);
        ctx.fillStyle = '#fed7aa';
        ctx.beginPath();
        ctx.arc(bx, by - 30, 4.5, 0, Math.PI * 2);
        ctx.fill();

        // Pointing arm
        ctx.strokeStyle = '#3b82f6';
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.moveTo(bx - 4, by - 22);
        ctx.lineTo(bx - 16, by - 26);
        ctx.stroke();
      }

      // 3. Child
      if (count >= 3) {
        const cx = rx + 34;
        const cy = ry - 35;

        ctx.fillStyle = '#334155';
        ctx.fillRect(cx - 3, cy - 10, 6, 11);
        ctx.fillStyle = '#eab308'; // yellow raincoat
        ctx.fillRect(cx - 4, cy - 19, 8, 10);
        ctx.fillStyle = '#fde68a';
        ctx.beginPath();
        ctx.arc(cx, cy - 23, 3.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    renderRescueBoat() {
      const ctx = this.ctx;
      const bx = this.boatX;
      const by = this.boatY;
      const t = this.animTime;

      ctx.save();
      ctx.translate(bx, by);
      ctx.rotate(this.boatAngle);

      // Water foam & spray at stern
      if (this.missionState !== 'DOCKING' && this.missionState !== 'BOARDING') {
        ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
        ctx.beginPath();
        ctx.ellipse(-32, 12, 20, 6, 0, 0, Math.PI * 2);
        ctx.fill();

        // Bow wave spray
        ctx.beginPath();
        ctx.ellipse(58, 10, 14, 5, 0.2, 0, Math.PI * 2);
        ctx.fill();
      }

      // Lower Hull
      ctx.fillStyle = '#0f172a';
      ctx.beginPath();
      ctx.moveTo(-35, 14);
      ctx.lineTo(46, 14);
      ctx.quadraticCurveTo(68, 8, 72, -2);
      ctx.lineTo(-38, -2);
      ctx.closePath();
      ctx.fill();

      // Upper High-Vis Orange Hull
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.moveTo(-38, -2);
      ctx.lineTo(70, -2);
      ctx.quadraticCurveTo(75, -8, 64, -14);
      ctx.lineTo(-35, -14);
      ctx.closePath();
      ctx.fill();

      // White Reflective Safety Stripe
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(-32, -6, 94, 3);

      // AquaEvac Decal
      ctx.fillStyle = '#0f172a';
      ctx.font = 'bold 7px sans-serif';
      ctx.fillText('AQUAEVAC RESCUE-01', -22, -8);

      // Outboard Motor
      ctx.fillStyle = '#1e293b';
      ctx.fillRect(-42, -10, 8, 22);
      ctx.fillStyle = '#0f172a';
      ctx.fillRect(-46, -14, 12, 8);

      // Cabin / Windshield
      ctx.fillStyle = '#0284c7';
      ctx.beginPath();
      ctx.moveTo(0, -14);
      ctx.lineTo(24, -14);
      ctx.lineTo(16, -26);
      ctx.lineTo(2, -26);
      ctx.closePath();
      ctx.fill();

      // Steering Console & Pilot
      ctx.fillStyle = '#ea580c';
      ctx.fillRect(6, -26, 8, 12);
      ctx.fillStyle = '#fed7aa';
      ctx.beginPath();
      ctx.arc(10, -29, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(10, -31, 4.5, Math.PI, Math.PI * 2);
      ctx.fill();

      // Front Rescue Responder holding lifebuoy
      ctx.fillStyle = '#ea580c';
      ctx.fillRect(36, -22, 7, 10);
      ctx.fillStyle = '#fed7aa';
      ctx.beginPath();
      ctx.arc(39.5, -25, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#dc2626';
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(46, -20, 5, 0, Math.PI * 2);
      ctx.stroke();

      // Survivors seated in the boat
      if (this.survivorsOnBoat >= 1) {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(-12, -22, 7, 10);
        ctx.fillStyle = '#fed7aa';
        ctx.beginPath();
        ctx.arc(-8.5, -25, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (this.survivorsOnBoat >= 2) {
        ctx.fillStyle = '#1e293b';
        ctx.fillRect(-22, -22, 7, 10);
        ctx.fillStyle = '#fed7aa';
        ctx.beginPath();
        ctx.arc(-18.5, -25, 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
      if (this.survivorsOnBoat >= 3) {
        ctx.fillStyle = '#fbbf24';
        ctx.fillRect(-4, -19, 7, 7);
        ctx.fillStyle = '#fed7aa';
        ctx.beginPath();
        ctx.arc(-0.5, -22, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Emergency Strobe Light on Mast
      ctx.fillStyle = '#475569';
      ctx.fillRect(18, -36, 3, 12);
      const strobeColor = Math.sin(t * 14) > 0 ? '#38bdf8' : '#f97316';
      ctx.fillStyle = strobeColor;
      ctx.beginPath();
      ctx.arc(19.5, -38, 4.5, 0, Math.PI * 2);
      ctx.fill();

      // Searchlight Beam cutting through storm
      const beamTargetX = 280;
      const beamGrad = ctx.createRadialGradient(22, -22, 5, 22 + beamTargetX, 40, 240);
      beamGrad.addColorStop(0, 'rgba(255, 255, 240, 0.70)');
      beamGrad.addColorStop(0.2, 'rgba(255, 255, 240, 0.40)');
      beamGrad.addColorStop(1, 'rgba(255, 255, 240, 0)');

      ctx.fillStyle = beamGrad;
      ctx.beginPath();
      ctx.moveTo(22, -22);
      ctx.lineTo(22 + beamTargetX, -10);
      ctx.lineTo(22 + beamTargetX, 95);
      ctx.closePath();
      ctx.fill();

      ctx.restore();
    }

    renderWaterLayers() {
      const ctx = this.ctx;
      const w = this.width;
      const h = this.height;
      const t = this.animTime;

      // Layer 1: Deep Back Floodwater
      ctx.fillStyle = '#0c2235';
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, this.waterBaseY - 6);
      for (let x = 0; x <= w; x += 25) {
        const y = this.waterBaseY - 6 + Math.sin(x * 0.008 + t * 1.8) * 7;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.fill();

      // Layer 2: Mid Water with reflections & waves
      const midGrad = ctx.createLinearGradient(0, this.waterBaseY, 0, h);
      midGrad.addColorStop(0, '#113a5a');
      midGrad.addColorStop(0.4, '#0d283e');
      midGrad.addColorStop(1, '#071624');
      ctx.fillStyle = midGrad;

      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, this.waterBaseY);
      for (let x = 0; x <= w; x += 20) {
        const y = this.waterBaseY + Math.sin(x * 0.012 - t * 2.2) * 5 + Math.cos(x * 0.02 + t * 1.4) * 3;
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.fill();

      // Floating debris
      this.renderFloatingDebris(t);

      // Layer 3: Foreground Crests & Highlights
      ctx.fillStyle = 'rgba(6, 182, 212, 0.16)';
      ctx.beginPath();
      ctx.moveTo(0, h);
      ctx.lineTo(0, this.waterBaseY + 4);
      for (let x = 0; x <= w; x += 15) {
        const y = this.getWaterSurfaceY(x, t);
        ctx.lineTo(x, y);
      }
      ctx.lineTo(w, h);
      ctx.fill();

      // Foam Crest line
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.40)';
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 12) {
        const y = this.getWaterSurfaceY(x, t);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Surface ripples
      for (const rip of this.ripples) {
        ctx.strokeStyle = `rgba(255, 255, 255, ${rip.alpha * 0.65})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.ellipse(rip.x, rip.y, rip.rx, rip.ry, 0, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Splashes
      for (const sp of this.splashes) {
        ctx.fillStyle = `rgba(224, 242, 254, ${sp.alpha})`;
        ctx.beginPath();
        ctx.arc(sp.x, sp.y, 1.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    renderFloatingDebris(t) {
      const ctx = this.ctx;

      // Wooden Plank with Warning Stripe
      const d1X = (this.width * 0.25 + Math.sin(t * 0.8) * 16);
      const d1Y = this.getWaterSurfaceY(d1X, t) + 2;
      ctx.save();
      ctx.translate(d1X, d1Y);
      ctx.rotate(Math.sin(t * 1.4) * 0.12);
      ctx.fillStyle = '#78350f';
      ctx.fillRect(-22, -4, 44, 8);
      ctx.fillStyle = '#fbbf24';
      ctx.fillRect(-8, -4, 16, 8);
      ctx.restore();

      // Floating Orange Life Buoy
      const d2X = (this.width * 0.88 + Math.cos(t * 0.9) * 14);
      const d2Y = this.getWaterSurfaceY(d2X, t) + 3;
      ctx.save();
      ctx.translate(d2X, d2Y);
      ctx.rotate(Math.cos(t * 1.1) * 0.15);
      ctx.strokeStyle = '#ea580c';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.arc(0, 0, 9, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    renderRain() {
      const ctx = this.ctx;
      ctx.save();
      for (const drop of this.raindrops) {
        ctx.strokeStyle = `rgba(215, 235, 255, ${Math.min(drop.alpha + 0.25, 0.90)})`;
        ctx.lineWidth = drop.thickness + 0.5;
        ctx.beginPath();
        ctx.moveTo(drop.x, drop.y);
        ctx.lineTo(drop.x - 7, drop.y + drop.length);
        ctx.stroke();
      }
      ctx.restore();
    }

    renderMissionHUD() {
      if (this.isDashboard) return;
      const ctx = this.ctx;
      const w = this.width;

      ctx.save();
      const hasHeader = !!document.querySelector('header');
      const bannerY = hasHeader ? 74 : 16;
      const bannerWidth = Math.min(w - 32, 640);
      const bx = (w - bannerWidth) / 2;

      ctx.fillStyle = 'rgba(8, 14, 25, 0.85)';
      ctx.strokeStyle = 'rgba(249, 115, 22, 0.5)';
      ctx.lineWidth = 1.2;

      this.drawRoundedRect(ctx, bx, bannerY, bannerWidth, 34, 17);
      ctx.fill();
      ctx.stroke();

      const pulseRadius = 4 + Math.sin(this.animTime * 6) * 1.8;
      ctx.fillStyle = this.missionState === 'DEPARTING' ? '#16a34a' : '#ea580c';
      ctx.beginPath();
      ctx.arc(bx + 18, bannerY + 17, pulseRadius, 0, Math.PI * 2);
      ctx.fill();

      ctx.font = '600 11px Inter, sans-serif';
      ctx.fillStyle = '#f8fafc';
      ctx.textAlign = 'left';
      ctx.fillText(this.missionMessage, bx + 32, bannerY + 21);

      ctx.restore();
    }

    buildFloatingControls() {
      // Floating Control Badge in bottom left corner (never conflicts with i18n language pill on right)
      let ctrl = document.getElementById('aquaevac-storm-controls');
      if (ctrl) return;

      ctrl = document.createElement('div');
      ctrl.id = 'aquaevac-storm-controls';
      ctrl.style.position = 'fixed';
      ctrl.style.bottom = '16px';
      if (this.isDashboard) {
        // Keep clear of the left sidebar and the map controls: bottom-centre of the map area.
        const wide = window.innerWidth >= 768;
        ctrl.style.left = wide ? 'calc(400px + (100vw - 400px) / 2)' : '50%';
        ctrl.style.transform = 'translateX(-50%)';
        ctrl.style.bottom = '12px';
      } else {
        ctrl.style.left = '16px';
      }
      ctrl.style.zIndex = '99999';
      ctrl.style.display = 'flex';
      ctrl.style.alignItems = 'center';
      ctrl.style.gap = '8px';
      ctrl.style.padding = '8px 12px';
      ctrl.style.borderRadius = '12px';
      ctrl.style.background = 'rgba(10, 15, 26, 0.90)';
      ctrl.style.border = '1px solid rgba(249, 115, 22, 0.4)';
      ctrl.style.boxShadow = '0 10px 25px -5px rgba(0, 0, 0, 0.5)';
      ctrl.style.backdropFilter = 'blur(10px)';
      ctrl.style.fontSize = '12px';
      ctrl.style.color = '#f1f5f9';
      ctrl.style.userSelect = 'none';

      ctrl.innerHTML = `
        <button id="aquaevac-lightning-btn" title="Simulate Thunder & Lightning" style="cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; background: #ea580c; color: #ffffff; font-weight: 600; border: none; box-shadow: 0 2px 8px rgba(234, 88, 12, 0.4);">
          <span>⚡</span>
          <span>Thunder & Lightning</span>
        </button>
        <button id="aquaevac-audio-btn" title="Toggle Storm & Rain Audio" style="cursor: pointer; display: flex; align-items: center; gap: 6px; padding: 6px 12px; border-radius: 8px; background: #1e293b; color: #cbd5e1; font-weight: 500; border: 1px solid rgba(255,255,255,0.1);">
          <span id="aquaevac-audio-icon">🔇</span>
          <span id="aquaevac-audio-label">Storm Sound</span>
        </button>
      `;

      if (document.body) {
        document.body.appendChild(ctrl);
      } else {
        document.addEventListener('DOMContentLoaded', () => {
          document.body.appendChild(ctrl);
        });
      }

      setTimeout(() => {
        const lightningBtn = document.getElementById('aquaevac-lightning-btn');
        if (lightningBtn) {
          lightningBtn.addEventListener('click', () => {
            this.triggerLightning();
          });
        }

        const audioBtn = document.getElementById('aquaevac-audio-btn');
        const audioIcon = document.getElementById('aquaevac-audio-icon');
        const audioLabel = document.getElementById('aquaevac-audio-label');

        if (audioBtn) {
          audioBtn.addEventListener('click', () => {
            this.toggleAudio();
            if (this.audioEnabled) {
              if (audioIcon) audioIcon.textContent = '🔊';
              if (audioLabel) audioLabel.textContent = 'Audio Active';
              audioBtn.style.background = '#16a34a';
              audioBtn.style.color = '#ffffff';
            } else {
              if (audioIcon) audioIcon.textContent = '🔇';
              if (audioLabel) audioLabel.textContent = 'Storm Sound';
              audioBtn.style.background = '#1e293b';
              audioBtn.style.color = '#cbd5e1';
            }
          });
        }
      }, 100);
    }

    toggleAudio() {
      if (!this.audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return;
        this.audioCtx = new AudioContext();
      }

      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      this.audioEnabled = !this.audioEnabled;

      if (this.audioEnabled) {
        this.startRainAudio();
      } else {
        this.stopRainAudio();
      }
    }

    startRainAudio() {
      if (!this.audioCtx) return;
      try {
        const bufferSize = this.audioCtx.sampleRate * 2;
        const noiseBuffer = this.audioCtx.createBuffer(1, bufferSize, this.audioCtx.sampleRate);
        const output = noiseBuffer.getChannelData(0);

        let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
        for (let i = 0; i < bufferSize; i++) {
          const white = Math.random() * 2 - 1;
          b0 = 0.99886 * b0 + white * 0.0555179;
          b1 = 0.99332 * b1 + white * 0.0750759;
          b2 = 0.96900 * b2 + white * 0.1538520;
          b3 = 0.86650 * b3 + white * 0.3104856;
          b4 = 0.55000 * b4 + white * 0.5329522;
          b5 = -0.7616 * b5 - white * 0.0168980;
          output[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.04;
          b6 = white * 0.115926;
        }

        const rainSource = this.audioCtx.createBufferSource();
        rainSource.buffer = noiseBuffer;
        rainSource.loop = true;

        const filter = this.audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(1400, this.audioCtx.currentTime);

        this.rainGain = this.audioCtx.createGain();
        this.rainGain.gain.setValueAtTime(0.12, this.audioCtx.currentTime);

        rainSource.connect(filter);
        filter.connect(this.rainGain);
        this.rainGain.connect(this.audioCtx.destination);

        rainSource.start();
        this.rainSource = rainSource;
      } catch (err) {
        console.warn('Audio init note:', err);
      }
    }

    stopRainAudio() {
      if (this.rainSource) {
        try {
          this.rainSource.stop();
          this.rainSource.disconnect();
        } catch (e) {}
        this.rainSource = null;
      }
    }

    playThunderSound() {
      if (!this.audioCtx || !this.audioEnabled) return;
      try {
        const now = this.audioCtx.currentTime;
        const osc = this.audioCtx.createOscillator();
        const gain = this.audioCtx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(80, now);
        osc.frequency.exponentialRampToValueAtTime(24, now + 1.8);

        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 2.2);

        osc.connect(gain);
        gain.connect(this.audioCtx.destination);

        osc.start(now);
        osc.stop(now + 2.2);
      } catch (e) {}
    }

    loop(timestamp) {
      const dt = Math.min((timestamp - this.lastTime) / 1000, 0.1);
      this.lastTime = timestamp;
      this.animTime += dt;

      // Lightning strike scheduler
      this.lightning.nextStrike -= dt;
      if (this.lightning.nextStrike <= 0) {
        this.triggerLightning();
      }
      if (this.lightning.flashAlpha > 0) {
        this.lightning.flashAlpha = Math.max(0, this.lightning.flashAlpha - dt * 2.6);
      }

      // Physics & state
      this.updateRain(dt);
      this.updateMission(dt);

      // Render
      this.ctx.clearRect(0, 0, this.width, this.height);
      this.renderSky();
      this.renderClouds();
      this.renderLightning();
      // On the dashboard the scene is see-through so the map, roads and the
      // blue route line stay clearly visible underneath it.
      if (this.isDashboard) this.ctx.globalAlpha = 0.45;
      this.renderWaterLayers();
      this.renderSubmergedRooftop();
      this.renderRescueBoat();
      this.ctx.globalAlpha = this.isDashboard ? 0.55 : 1;
      this.renderRain();
      this.ctx.globalAlpha = 1;
      this.renderMissionHUD();

      requestAnimationFrame(this.loop);
    }
  }

  // Initialize singleton when DOM is ready
  function initAquaEvacFloodAnimation() {
    if (!window.__AquaEvacFloodScene) {
      window.__AquaEvacFloodScene = new AquaEvacFloodScene();
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAquaEvacFloodAnimation);
  } else {
    initAquaEvacFloodAnimation();
  }

  window.AquaEvacFloodScene = AquaEvacFloodScene;
})();
