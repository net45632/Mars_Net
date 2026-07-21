document.addEventListener('DOMContentLoaded', function() {

  if (typeof Plotly === 'undefined') {
    console.error('Plotly failed to load — check your <script src="..."> tag/order.');
    return;
  }

  const plotDiv = document.getElementById('plot-container');
  if (!plotDiv) {
    console.error('plot-container div not found — check the id matches your HTML.');
    return;
  }

  const numSats = 8;
  const numPlanes = 3;
  let timeStep = 0;
  let isAnimating = true;
  let aiEnabled = false; // AI ON/OFF toggle — gates whether maneuvering affects satellite radius; starts OFF

  const altVal = document.getElementById('alt-val');
  const speedSlider = document.getElementById('speed');
  const speedVal = document.getElementById('speed-val');
  const toggleBtn = document.getElementById('toggle-sim');
  const statusText = document.getElementById('status-text');

  // Optional elements for the AI toggle + Collisions tab.
  // Guarded everywhere below so this file works even before these exist in index.html.
  const aiToggleBtn = document.getElementById('ai-toggle-btn');
  const resetViewBtn = document.getElementById('reset-view-btn');
  const tabBtnControl = document.getElementById('tab-btn-control');
  const tabBtnCollisions = document.getElementById('tab-btn-collisions');
  const tabBtnTelemetry = document.getElementById('tab-btn-telemetry');
  const tabPanelControl = document.getElementById('tab-panel-control');
  const tabPanelCollisions = document.getElementById('tab-panel-collisions');
  const tabPanelTelemetry = document.getElementById('tab-panel-telemetry');
  const telemetryChartEl = document.getElementById('telemetry-chart');
  const satTableBodyEl = document.getElementById('sat-table-body');
  const decisionLogEl = document.getElementById('decision-log');
  const reportChartImg = document.getElementById('report-chart-img');
  const reportChartFallback = document.getElementById('report-chart-fallback');
  const offCountEl = document.getElementById('off-collision-count');
  const onCountEl = document.getElementById('on-collision-count');
  const offRateEl = document.getElementById('off-collision-rate');
  const onRateEl = document.getElementById('on-collision-rate');
  const reductionEl = document.getElementById('collision-reduction');
  const collisionLogEl = document.getElementById('collision-log');

  const planeRadiiBase = [1.6, 2.4, 3.2];
  const inclinations = [0.2, 0.5, 0.78];
  const nodes = [0.5, 2.1, 4.5];

  // --- 1. STARS GENERATOR ---
  function buildStars() {
      let numStars = 400;
      let x = [], y = [], z = [];
      let colors = [];
      const starColors = ['#ffffff', '#e0f2fe', '#f3e8ff', '#ffffff'];

      const rMin = 3.0, rMax = 14.0;
      for(let i=0; i<numStars; i++) {
          let r = Math.cbrt(Math.random() * (Math.pow(rMax, 3) - Math.pow(rMin, 3)) + Math.pow(rMin, 3));
          let theta = Math.random() * 2 * Math.PI;
          let phi = Math.random() * Math.PI;

          x.push(r * Math.sin(phi) * Math.cos(theta));
          y.push(r * Math.sin(phi) * Math.sin(theta));
          z.push(r * Math.cos(phi));
          colors.push(starColors[Math.floor(Math.random() * starColors.length)]);
      }
      return {
          type: 'scatter3d', mode: 'markers', x: x, y: y, z: z,
          marker: { size: 1.5, color: colors, opacity: 0.8 },
          showlegend: false, hoverinfo: 'none'
      };
  }

  // --- 2. MARS GENERATOR (rotating surface texture) ---
  // The sphere geometry itself never changes shape, so "rotation" is faked cheaply by
  // shifting a longitude-based texture pattern across the surface each frame — the
  // standard trick for animating a rotationally-symmetric mesh without recomputing geometry.
  const marsU = [];
  const marsV = [];
  for (let i = 0; i <= 30; i++) marsU.push(i * 2 * Math.PI / 30);
  for (let i = 0; i <= 30; i++) marsV.push(i * Math.PI / 30);

  function marsTexture(u, v) {
      // A few blended sine waves fake continents/albedo features on the surface
      return Math.sin(3*u + 1.3*v) * 0.5 + Math.sin(5*u - 2.1*v) * 0.3 + Math.sin(1.7*u + 4*v) * 0.2;
  }

  function buildMarsGeometry() {
      let x = [], y = [], z = [];
      for (let i = 0; i <= 30; i++) {
          let x_row = [], y_row = [], z_row = [];
          for (let j = 0; j <= 30; j++) {
              x_row.push(Math.cos(marsU[j]) * Math.sin(marsV[i]));
              y_row.push(Math.sin(marsU[j]) * Math.sin(marsV[i]));
              z_row.push(Math.cos(marsV[i]));
          }
          x.push(x_row); y.push(y_row); z.push(z_row);
      }
      return { x: x, y: y, z: z };
  }

  function buildMarsColor(rotationAngle) {
      let color = [];
      for (let i = 0; i <= 30; i++) {
          let row = [];
          for (let j = 0; j <= 30; j++) {
              let base = Math.cos(marsV[i]); // same latitude gradient as the original
              let feature = marsTexture(marsU[j] - rotationAngle, marsV[i]) * 0.55;
              row.push(base + feature);
          }
          color.push(row);
      }
      return color;
  }

  const MARS_ROTATION_SPEED = 0.01;

  // --- 3. DECORATIVE DEBRIS (background clutter, not a collision threat) ---
  function buildDebris(density) {
      let numDebris = Math.floor(150 * density);
      let x = [], y = [], z = [];
      for(let i=0; i<numDebris; i++) {
          let r = 1.2 + Math.random() * 2.3;
          let theta = Math.random() * 2 * Math.PI;
          let phi = Math.random() * Math.PI;
          x.push(r * Math.sin(phi) * Math.cos(theta));
          y.push(r * Math.sin(phi) * Math.sin(theta));
          z.push(r * Math.cos(phi));
      }
      return {
          type: 'scatter3d', mode: 'markers', x: x, y: y, z: z,
          marker: { size: 1.5, color: '#ff7b72', opacity: 0.25 },
          showlegend: false, hoverinfo: 'none'
      };
  }

  // --- 4. SATELLITE POSITION CALCULATION ---
  function getSatellites(altitudeMult, t) {
      let x = [], y = [], z = [];
      for (let i = 0; i < numSats; i++) {
          let pIdx = i % numPlanes;
          let r = Math.max(planeRadiiBase[pIdx] * altitudeMult, 1.4);
          let inc = inclinations[pIdx];
          let node = nodes[pIdx];

          let spacingOffset = (2 * Math.PI / Math.max(1, Math.floor(numSats / numPlanes))) * Math.floor(i / numPlanes);
          let angularSpeed = Math.sqrt(10.0 / Math.pow(r, 3));
          let currentTheta = spacingOffset + (angularSpeed * t * 0.15);

          x.push(r * (Math.cos(currentTheta) * Math.cos(node) - Math.sin(currentTheta) * Math.sin(node) * Math.cos(inc)));
          y.push(r * (Math.cos(currentTheta) * Math.sin(node) + Math.sin(currentTheta) * Math.cos(node) * Math.cos(inc)));
          z.push(r * (Math.sin(currentTheta) * Math.sin(inc)));
      }
      return { x: x, y: y, z: z };
  }

  // --- 5. THREAT DEBRIS ---
  // Each threat debris shares its target satellite's plane (inclination + node) but has its own
  // FIXED radius that the AI can never influence. Because that radius differs slightly from the
  // satellite's baseline radius, their angular speeds differ (Kepler's third law), so their
  // relative phase drifts over time and they periodically converge — a real conjunction. When
  // the AI shifts the satellite's radius, it can open a gap at the moment of closest approach.
  // With AI off, the satellite stays at its fixed baseline radius with no way to dodge.
  const THREATS_PER_SAT = 2;
  const COLLISION_RADIUS = 0.35;
  const RESPAWN_MIN_OFFSET = 0.15;
  const RESPAWN_MAX_OFFSET = 0.55;

  function randomOffset() {
      let mag = RESPAWN_MIN_OFFSET + Math.random() * (RESPAWN_MAX_OFFSET - RESPAWN_MIN_OFFSET);
      return Math.random() < 0.5 ? -mag : mag;
  }

  function makeThreat(satIdx, id) {
      let pIdx = satIdx % numPlanes;
      let spacingOffset = (2 * Math.PI / Math.max(1, Math.floor(numSats / numPlanes))) * Math.floor(satIdx / numPlanes);
      return {
          id: id,
          satIdx: satIdx,
          pIdx: pIdx,
          radius: Math.max(planeRadiiBase[pIdx] + randomOffset(), 1.1),
          phase: spacingOffset + Math.random() * 2 * Math.PI,
          colliding: false
      };
  }

  let threatState = [];
  for (let s = 0; s < numSats; s++) {
      for (let k = 0; k < THREATS_PER_SAT; k++) {
          threatState.push(makeThreat(s, 'DBR-' + String(s) + String(k)));
      }
  }

  function getThreatPositions(t) {
      let x = [], y = [], z = [];
      for (let i = 0; i < threatState.length; i++) {
          let th = threatState[i];
          let inc = inclinations[th.pIdx];
          let node = nodes[th.pIdx];
          let angularSpeed = Math.sqrt(10.0 / Math.pow(th.radius, 3));
          let currentTheta = th.phase + (angularSpeed * t * 0.15);

          x.push(th.radius * (Math.cos(currentTheta) * Math.cos(node) - Math.sin(currentTheta) * Math.sin(node) * Math.cos(inc)));
          y.push(th.radius * (Math.cos(currentTheta) * Math.sin(node) + Math.sin(currentTheta) * Math.cos(node) * Math.cos(inc)));
          z.push(th.radius * (Math.sin(currentTheta) * Math.sin(inc)));
      }
      return { x: x, y: y, z: z };
  }

  // --- 5b. MARS MOONS (Phobos & Deimos) ---
  // Same angularSpeed = sqrt(k/r^3) relation used for satellites and threat debris above:
  // Phobos orbits closer and faster, Deimos farther and slower — same physics, smaller scale.
  const marsMoons = [
      { name: 'Phobos', radius: 1.7, inc: 0.05, node: 0.0, phase: 0.0, size: 3.5, color: '#9c9284' },
      { name: 'Deimos', radius: 2.3, inc: 0.08, node: 1.2, phase: 2.1, size: 2.8, color: '#c8c2b6' }
  ];

  function getMoonPositions(t) {
      let x = [], y = [], z = [];
      for (let i = 0; i < marsMoons.length; i++) {
          let m = marsMoons[i];
          let angularSpeed = Math.sqrt(10.0 / Math.pow(m.radius, 3));
          let theta = m.phase + angularSpeed * t * 0.15;
          x.push(m.radius * (Math.cos(theta) * Math.cos(m.node) - Math.sin(theta) * Math.sin(m.node) * Math.cos(m.inc)));
          y.push(m.radius * (Math.cos(theta) * Math.sin(m.node) + Math.sin(theta) * Math.cos(m.node) * Math.cos(m.inc)));
          z.push(m.radius * (Math.sin(theta) * Math.sin(m.inc)));
      }
      return { x: x, y: y, z: z };
  }

  // --- 6b. TELEMETRY DASHBOARD ---
  // Rolling buffer feeding the live orbit-multiplier chart
  const TELEMETRY_WINDOW = 100;
  let telemetryTimes = [];
  let telemetryValues = [];

  const CAUTION_DISTANCE = 0.9; // wider than COLLISION_RADIUS — an early-warning zone, not a hit
  let satStatusState = new Array(numSats).fill('SAFE');
  let lastLoggedMultiplier = 1.0;

  function logDecision(text) {
      if (!decisionLogEl) return;
      let entry = document.createElement('div');
      entry.textContent = 'T+' + timeStep.toFixed(0) + ' — ' + text;
      decisionLogEl.prepend(entry);
      while (decisionLogEl.children.length > 25) {
          decisionLogEl.removeChild(decisionLogEl.lastChild);
      }
  }

  function getNearestThreatDistances(satX, satY, satZ, threatX, threatY, threatZ) {
      let nearest = new Array(numSats).fill(Infinity);
      for (let i = 0; i < threatState.length; i++) {
          let th = threatState[i];
          let dx = satX[th.satIdx] - threatX[i];
          let dy = satY[th.satIdx] - threatY[i];
          let dz = satZ[th.satIdx] - threatZ[i];
          let dist = Math.sqrt(dx*dx + dy*dy + dz*dz);
          if (dist < nearest[th.satIdx]) nearest[th.satIdx] = dist;
      }
      return nearest;
  }

  function updateSatTable(satX, satY, satZ, nearestDist) {
      if (!satTableBodyEl) return;
      let rows = '';
      for (let i = 0; i < numSats; i++) {
          let dist = nearestDist[i];
          let status = dist < COLLISION_RADIUS ? 'DANGER' : (dist < CAUTION_DISTANCE ? 'CAUTION' : 'SAFE');
          let statusClass = 'status-' + status.toLowerCase();
          let radius = Math.sqrt(satX[i]*satX[i] + satY[i]*satY[i] + satZ[i]*satZ[i]);
          rows += '<tr class="' + statusClass + '"><td>SAT-' + i + '</td><td>' + radius.toFixed(2) +
                  '</td><td>' + (isFinite(dist) ? dist.toFixed(2) : '—') + '</td><td>' + status + '</td></tr>';

          if (status !== satStatusState[i]) {
              if (status === 'CAUTION' && satStatusState[i] === 'SAFE') {
                  logDecision('SAT-' + i + ' entering caution zone (nearest threat: ' + dist.toFixed(2) + ')');
              } else if (status === 'SAFE' && satStatusState[i] !== 'SAFE') {
                  logDecision('SAT-' + i + ' clear of nearby threats');
              }
              satStatusState[i] = status;
          }
      }
      satTableBodyEl.innerHTML = rows;
  }

  function updateTelemetryChart(multiplier) {
      telemetryTimes.push(timeStep);
      telemetryValues.push(multiplier);
      if (telemetryTimes.length > TELEMETRY_WINDOW) {
          telemetryTimes.shift();
          telemetryValues.shift();
      }
      if (telemetryChartEl && telemetryChartInitialized) {
          Plotly.restyle(telemetryChartEl, { x: [telemetryTimes], y: [telemetryValues] }, [0]);
      }

      if (Math.abs(multiplier - lastLoggedMultiplier) > 0.05) {
          logDecision('Model adjusted orbit multiplier to ' + multiplier.toFixed(2) + 'x');
          lastLoggedMultiplier = multiplier;
      }
  }

  let telemetryChartInitialized = false;
  if (telemetryChartEl) {
      Plotly.newPlot(telemetryChartEl, [{
          type: 'scatter', mode: 'lines', x: [], y: [],
          line: { color: '#58a6ff', width: 2 }
      }], {
          margin: { l: 30, r: 10, t: 10, b: 25 },
          paper_bgcolor: '#0d1117', plot_bgcolor: '#0d1117',
          font: { color: '#8b949e', size: 9 },
          xaxis: { showgrid: false, zeroline: false },
          yaxis: { showgrid: true, gridcolor: '#21262d', zeroline: false, range: [0.7, 1.3] }
      }, { displayModeBar: false, responsive: true });
      telemetryChartInitialized = true;
  }

  // --- Embedded matplotlib session report (server-rendered, refreshes periodically) ---
  if (reportChartImg) {
      reportChartImg.addEventListener('error', () => {
          reportChartImg.classList.add('hidden');
          if (reportChartFallback) reportChartFallback.classList.remove('hidden');
      });
      reportChartImg.addEventListener('load', () => {
          reportChartImg.classList.remove('hidden');
          if (reportChartFallback) reportChartFallback.classList.add('hidden');
      });

      function refreshReportChart() {
          reportChartImg.src = 'http://127.0.0.1:8000/report-chart?t=' + Date.now();
      }

      refreshReportChart();
      setInterval(refreshReportChart, 3000);
  }

  // --- Periodic telemetry snapshot: sends the REAL simulation state (collisions, distances)
  // to the backend every 2 seconds, so the server-side log/report reflect actual outcomes
  // instead of just the model's own internal multiplier.
  function sendTelemetrySnapshot() {
      let finiteDistances = latestNearestDist.filter(d => isFinite(d));
      let minDist = finiteDistances.length ? Math.min(...finiteDistances) : null;
      let numCaution = latestNearestDist.filter(d => d < CAUTION_DISTANCE && d >= COLLISION_RADIUS).length;
      let numDanger = latestNearestDist.filter(d => d < COLLISION_RADIUS).length;

      fetch('http://127.0.0.1:8000/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
              elapsed_seconds: timeStep,
              ai_enabled: aiEnabled,
              altitude_multiplier: latestMultiplier,
              off_collisions: stats.offCollisions,
              on_collisions: stats.onCollisions,
              off_time_ms: stats.offTimeMs,
              on_time_ms: stats.onTimeMs,
              min_nearest_distance: minDist,
              num_caution: numCaution,
              num_danger: numDanger
          })
      }).catch(() => { /* backend unreachable — ignore, same graceful pattern as /next-step */ });
  }
  setInterval(sendTelemetrySnapshot, 2000);

  // --- 6c. COLLISION STATS ---
  const stats = {
      offCollisions: 0,
      onCollisions: 0,
      offTimeMs: 0,
      onTimeMs: 0
  };
  let lastFrameTime = performance.now();

  function logCollision(threat, modeLabel) {
      if (!collisionLogEl) return;
      let entry = document.createElement('div');
      entry.textContent = 'T+' + timeStep.toFixed(0) + ' — ' + threat.id + ' hit SAT-' + threat.satIdx + ' — Mode: ' + modeLabel;
      collisionLogEl.prepend(entry);
      while (collisionLogEl.children.length > 25) {
          collisionLogEl.removeChild(collisionLogEl.lastChild);
      }
  }

  function updateCollisionUI() {
      if (offCountEl) offCountEl.textContent = stats.offCollisions;
      if (onCountEl) onCountEl.textContent = stats.onCollisions;

      let offRate = stats.offTimeMs > 0 ? (stats.offCollisions / (stats.offTimeMs / 60000)) : 0;
      let onRate = stats.onTimeMs > 0 ? (stats.onCollisions / (stats.onTimeMs / 60000)) : 0;

      if (offRateEl) offRateEl.textContent = offRate.toFixed(1) + '/min';
      if (onRateEl) onRateEl.textContent = onRate.toFixed(1) + '/min';

      if (reductionEl) {
          if (offRate > 0) {
              let reduction = ((offRate - onRate) / offRate) * 100;
              reductionEl.textContent = reduction.toFixed(0) + '%';
          } else {
              reductionEl.textContent = '—';
          }
      }
  }

  function checkCollisions(satX, satY, satZ, threatX, threatY, threatZ) {
      let modeLabel = aiEnabled ? 'AI ON' : 'AI OFF';
      for (let i = 0; i < threatState.length; i++) {
          let th = threatState[i];
          let dx = satX[th.satIdx] - threatX[i];
          let dy = satY[th.satIdx] - threatY[i];
          let dz = satZ[th.satIdx] - threatZ[i];
          let dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

          if (dist < COLLISION_RADIUS) {
              if (!th.colliding) {
                  th.colliding = true;
                  if (aiEnabled) { stats.onCollisions++; } else { stats.offCollisions++; }
                  logCollision(th, modeLabel);
                  // Respawn this threat on a fresh orbit so it can threaten again later
                  threatState[i] = makeThreat(th.satIdx, th.id);
              }
          } else {
              th.colliding = false;
          }
      }
  }

  let latestSats = { x: [], y: [], z: [] }; // updated every frame, used by click-to-zoom
  let latestNearestDist = new Array(numSats).fill(Infinity); // updated every frame, used by periodic telemetry POST
  let latestMultiplier = 1.0; // updated every frame, used by periodic telemetry POST

  // Set up initial data array
  let marsGeom = buildMarsGeometry();
  let data = [
      buildStars(),
      {
          type: 'surface', x: marsGeom.x, y: marsGeom.y, z: marsGeom.z,
          surfacecolor: buildMarsColor(0),
          cmin: -1.55, cmax: 1.55,
          colorscale: [[0, 'rgb(140, 30, 15)'], [0.5, 'rgb(210, 60, 30)'], [1, 'rgb(80, 15, 5)']],
          showscale: false, name: 'Mars', hoverinfo: 'none'
      },
      buildDebris(0.35)
  ];
  let initSats = getSatellites(1.0, 0);
  let initThreats = getThreatPositions(0);
  latestSats = initSats;

  let satLabels = [];
  for (let i = 0; i < numSats; i++) satLabels.push('SAT-' + i);

  data.push({
      type: 'scatter3d', mode: 'markers',
      x: initSats.x, y: initSats.y, z: initSats.z,
      marker: { size: 6, color: '#58a6ff', line: { color: '#ffffff', width: 1 } },
      text: satLabels, hoverinfo: 'text',
      name: 'Satellites'
  });

  data.push({
      type: 'scatter3d', mode: 'markers',
      x: initThreats.x, y: initThreats.y, z: initThreats.z,
      marker: { size: 4, color: '#ffa657', opacity: 0.95 },
      name: 'Threat Debris'
  });

  let initMoons = getMoonPositions(0);
  data.push({
      type: 'scatter3d', mode: 'markers',
      x: initMoons.x, y: initMoons.y, z: initMoons.z,
      marker: { size: marsMoons.map(m => m.size), color: marsMoons.map(m => m.color) },
      text: marsMoons.map(m => m.name), hoverinfo: 'text',
      name: 'Moons'
  });

  const AXIS_X_RANGE = 14;
  const AXIS_Y_RANGE = 14;
  const AXIS_Z_RANGE = 14;
  const defaultCamera = {
      up: { x: 0, y: 0, z: 1 },
      center: { x: 0, y: 0, z: 0 },
      eye: { x: .35, y: .35, z: .35 }
  };

  let layout = {
      scene: {
          xaxis: { visible: false, range: [-AXIS_X_RANGE, AXIS_X_RANGE] },
          yaxis: { visible: false, range: [-AXIS_Y_RANGE, AXIS_Y_RANGE] },
          zaxis: { visible: false, range: [-AXIS_Z_RANGE, AXIS_Z_RANGE] },
          aspectmode: 'data',
          bgcolor: '#000000',
          camera: defaultCamera
      },
      margin: { l: 0, r: 0, b: 0, t: 0 },
      paper_bgcolor: '#000000',
      showlegend: false
  };

  // Render base plot layout immediately
  Plotly.newPlot(plotDiv, data, layout, { responsive: true });

  // --- CLICK-TO-ZOOM / FOLLOW: click a satellite marker to lock the camera onto it,
  // re-applied every animation frame so the camera tracks it as it orbits.
  // Plotly's camera eye/center use a normalized coordinate system based on each axis's
  // range, not raw scene units — dividing by each axis's half-range approximates that.
  let followedSatIndex = null;

  const CAMERA_SCALE = Math.max(AXIS_X_RANGE, AXIS_Y_RANGE, AXIS_Z_RANGE); // shared normalization scale for all 3 axes

  function cameraForSatellite(satIdx, satsX, satsY, satsZ) {
      let nx = satsX[satIdx] / CAMERA_SCALE;
      let ny = satsY[satIdx] / CAMERA_SCALE;
      let nz = satsZ[satIdx] / CAMERA_SCALE;
      return {
          up: { x: 0, y: 0, z: 1 },
          center: { x: nx, y: ny, z: nz },
          eye: { x: nx + 0.09, y: ny + 0.09, z: nz + 0.06 }
      };
  }

  function focusOnSatellite(satIdx) {
      Plotly.relayout(plotDiv, {
          'scene.camera': cameraForSatellite(satIdx, latestSats.x, latestSats.y, latestSats.z)
      });
  }

  function resetCameraView() {
      followedSatIndex = null;
      Plotly.relayout(plotDiv, { 'scene.camera': defaultCamera });
  }

  plotDiv.on('plotly_click', function(eventData) {
      if (!eventData || !eventData.points || !eventData.points.length) return;
      let point = eventData.points[0];
      if (point.curveNumber === 3) { // trace index 3 = Satellites
          if (followedSatIndex === point.pointNumber) {
              resetCameraView(); // clicking the currently-followed satellite again releases it
          } else {
              followedSatIndex = point.pointNumber;
              focusOnSatellite(followedSatIndex);
          }
      }
  });

  // --- 7. ANIMATION FRAME ENGINE WITH BACKUP MODE ---
  async function animateLoop() {
      if (!isAnimating) return;

      let currentAltitudeMultiplier = 1.0;

      try {
          // Try fetching data from Python FastAPI local backend
          let response = await fetch('http://127.0.0.1:8000/next-step');
          let aiData = await response.json();

          // Support both object property naming variations (.altitude_multiplier vs .multiplier)
          currentAltitudeMultiplier = aiData.altitude_multiplier || aiData.multiplier || 1.0;
          statusText.innerText = aiData.mode || "Live Grid Connected";
          statusText.style.color = '#58a6ff';

      } catch (error) {
          // Fallback Backup Engine if Python server can't be reached directly by browser
          statusText.innerText = "Internal Sync (Backup Active)";
          statusText.style.color = '#ffb454';

          // Simulates an AI breathing orbit cycle natively
          currentAltitudeMultiplier = 1.0 + 0.15 * Math.sin(timeStep * 0.05);
      }

      // The AI toggle gates whether the model's maneuvering actually affects satellite motion.
      // With AI off, satellites stay on their fixed baseline radius no matter what the model says.
      let effectiveMultiplier = aiEnabled ? currentAltitudeMultiplier : 1.0;

      altVal.innerText = currentAltitudeMultiplier.toFixed(2);
      let speed = parseFloat(speedSlider.value);
      timeStep += speed;

      let newSats = getSatellites(effectiveMultiplier, timeStep);
      let newThreats = getThreatPositions(timeStep);
      let newMoons = getMoonPositions(timeStep);
      latestSats = newSats;

      checkCollisions(newSats.x, newSats.y, newSats.z, newThreats.x, newThreats.y, newThreats.z);

      let nearestDist = getNearestThreatDistances(newSats.x, newSats.y, newSats.z, newThreats.x, newThreats.y, newThreats.z);
      latestNearestDist = nearestDist;
      latestMultiplier = currentAltitudeMultiplier;
      updateSatTable(newSats.x, newSats.y, newSats.z, nearestDist);
      updateTelemetryChart(currentAltitudeMultiplier);

      // Track real wall-clock time spent in each mode, for a fair collisions-per-minute stat
      let now = performance.now();
      let dt = now - lastFrameTime;
      lastFrameTime = now;
      if (aiEnabled) { stats.onTimeMs += dt; } else { stats.offTimeMs += dt; }

      updateCollisionUI();

      // Mars rotation: shift the surface texture rather than recomputing geometry (trace index 1)
      Plotly.restyle(plotDiv, { surfacecolor: [buildMarsColor(timeStep * MARS_ROTATION_SPEED)] }, [1]);

      // Force draw updates down to Plotly layer indices [3] (satellites), [4] (threat debris),
      // and [5] (moons). When following a satellite, bundle the camera update into the same
      // call so the view re-locks onto it every frame instead of drifting off as it orbits.
      let dataUpdate = {
          'x': [newSats.x, newThreats.x, newMoons.x],
          'y': [newSats.y, newThreats.y, newMoons.y],
          'z': [newSats.z, newThreats.z, newMoons.z]
      };

      if (followedSatIndex !== null) {
          Plotly.update(plotDiv, dataUpdate, {
              'scene.camera': cameraForSatellite(followedSatIndex, newSats.x, newSats.y, newSats.z)
          }, [3, 4, 5]);
      } else {
          Plotly.restyle(plotDiv, dataUpdate, [3, 4, 5]);
      }

      requestAnimationFrame(animateLoop);
  }

  // Launch application loop
  requestAnimationFrame(animateLoop);

  speedSlider.addEventListener('input', (e) => { speedVal.innerText = e.target.value; });
  toggleBtn.addEventListener('click', () => {
      isAnimating = !isAnimating;
      toggleBtn.innerText = isAnimating ? "⏸ Pause Simulation" : "▶ Resume Simulation";
      if (isAnimating) requestAnimationFrame(animateLoop);
  });

  if (aiToggleBtn) {
      aiToggleBtn.addEventListener('click', () => {
          aiEnabled = !aiEnabled;
          aiToggleBtn.innerText = aiEnabled ? "🤖 AI: ON" : "🤖 AI: OFF";
          aiToggleBtn.classList.toggle('off', !aiEnabled);
      });
  }

  if (resetViewBtn) {
      resetViewBtn.addEventListener('click', resetCameraView);
  }

  const allTabBtns = [tabBtnControl, tabBtnCollisions, tabBtnTelemetry];
  const allTabPanels = [tabPanelControl, tabPanelCollisions, tabPanelTelemetry];

  function activateTab(activeBtn, activePanel) {
      for (let i = 0; i < allTabBtns.length; i++) {
          if (!allTabBtns[i] || !allTabPanels[i]) continue;
          let isActive = (allTabBtns[i] === activeBtn);
          allTabBtns[i].classList.toggle('active', isActive);
          allTabPanels[i].classList.toggle('hidden', !isActive);
      }
  }

  if (tabBtnControl) tabBtnControl.addEventListener('click', () => activateTab(tabBtnControl, tabPanelControl));
  if (tabBtnCollisions) tabBtnCollisions.addEventListener('click', () => activateTab(tabBtnCollisions, tabPanelCollisions));
  if (tabBtnTelemetry) {
      tabBtnTelemetry.addEventListener('click', () => {
          activateTab(tabBtnTelemetry, tabPanelTelemetry);
          // Plotly needs a resize nudge the first time a previously-hidden chart div becomes visible
          if (telemetryChartEl) Plotly.Plots.resize(telemetryChartEl);
      });
  }

}); // closes document.addEventListener('DOMContentLoaded', ...)