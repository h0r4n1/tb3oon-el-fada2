// NEBULA - mission planner page (demo flow).
//
// The demo story, in order:
//   intro -> callsign + choose Jezero -> map: inspect a science target ->
//   compare routes (engine) -> start the simulated rover -> pause and propose
//   a science stop (engine) -> accept or cancel -> arrive -> return to base
//   (engine) -> mission summary.
//
// HONESTY RULES this file follows:
//   - Every route number (distance, time, energy, scores, verdicts, reasons,
//     reserves) comes from the route engine via POST /api/routes. This file
//     never calculates a score or a feasibility verdict itself.
//   - The live mission state (elapsed time, battery, rover position) is a
//     SIMULATION that spends the engine's own minutes and kWh as time passes.
//   - Labels on screen say which values are OBSERVED (NASA data), DERIVED
//     (engine output), SIMULATED (this playback) or EDITORIAL (team rubric).

import { mountMarsMap } from './adapters/mars-map.js';
import { createApiClient } from './api-client.js';

const $ = (id) => document.getElementById(id);
const api = createApiClient();
const L = window.L;

// ---------------------------------------------------------------------------
// Small helpers for building the page safely (text is never parsed as HTML).
// ---------------------------------------------------------------------------

// el('p', {class: 'x'}, 'text', child...) -> a new element.
function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

// A small coloured label: OBSERVED / DERIVED / SIMULATED / EDITORIAL.
const tag = (kind) => el('span', { class: `tag tag-${kind.toLowerCase()}` }, kind);

// Number formatting. Unknown (null) values are shown as "unknown", never 0.
const fmt = (value, digits = 1, unit = '') =>
  Number.isFinite(value) ? `${value.toFixed(digits)}${unit ? ' ' + unit : ''}` : 'unknown';

const findReason = (candidate, prefix) => candidate.reasons.find((r) => r.startsWith(prefix)) ?? null;
const ROLE_PREFIXES = ['Recommended', 'Fastest', 'Science-focused'];
const rolesOf = (candidate) => ROLE_PREFIXES.filter((role) => findReason(candidate, role + ':'));
const isDetour = (candidate) => candidate.id.includes('+detour-');

// Reasons a person needs first: roles, detour summary, verdict problems,
// "unverified" notes and the return reserve. Everything else goes in "details".
function keyReasons(candidate) {
  return candidate.reasons.filter((r) =>
    ROLE_PREFIXES.some((role) => r.startsWith(role + ':')) ||
    r.startsWith('Only one feasible route') ||
    r.startsWith('Optional science detour') ||
    r.startsWith('Not enough') ||
    r.includes('UNVERIFIED') ||
    r.includes('exceeds') ||
    r.startsWith('No return path') ||
    r.startsWith('Return reserve:'));
}

// ---------------------------------------------------------------------------
// App state.
// ---------------------------------------------------------------------------
const state = {
  callsign: '',
  region: null,          // from GET /api/region
  config: null,          // from GET /api/config (prototype assumptions)
  targets: new Map(),    // id -> target properties + {lat, lon}
  map: null,             // Leaflet map wrapper
  layers: {},            // our own Leaflet layers (targets, route, rover)
  selectedTargetId: null,
  mission: null,         // the simulated mission (see startMission)
  pendingRequestId: null,
};

// ---------------------------------------------------------------------------
// 1. Intro and 2. callsign + region.
// ---------------------------------------------------------------------------
function show(screen) {
  for (const id of ['screenIntro', 'screenSetup', 'screenPlanner']) $(id).hidden = id !== screen;
  if (screen === 'screenPlanner') requestAnimationFrame(() => state.map?.resize());
}

$('startIntro').onclick = () => {
  show('screenSetup');
  $('callsign').focus();
};

// Other regions are shown as previews only: they cannot start a mission.
const PREVIEW_REGIONS = [
  { name: 'Gale Crater', note: 'Preview · coming soon · no data loaded' },
  { name: 'Utopia Planitia', note: 'Preview · coming soon · no data loaded' },
];

function renderRegionCards() {
  const cards = $('regionCards');
  cards.replaceChildren();
  if (state.region) {
    cards.append(el('label', { class: 'region-card available' },
      el('input', { type: 'radio', name: 'region', value: state.region.id, checked: true }),
      el('b', {}, state.region.name),
      el('small', {}, state.region.status === 'demo' ? 'Demo available · real NASA traverse data' : 'Preview')));
  } else {
    cards.append(el('p', { class: 'fine' }, 'Loading region data…'));
  }
  for (const preview of PREVIEW_REGIONS) {
    cards.append(el('label', { class: 'region-card preview', 'aria-disabled': 'true' },
      el('input', { type: 'radio', name: 'region', disabled: true }),
      el('b', {}, preview.name),
      el('small', {}, preview.note)));
  }
}

$('enterRegion').onclick = () => {
  const callsign = $('callsign').value.trim().slice(0, 24);
  if (!callsign) {
    $('setupError').textContent = 'Enter a crew callsign first.';
    $('callsign').focus();
    return;
  }
  if (!state.region || state.region.status !== 'demo') {
    $('setupError').textContent = 'Region data is not loaded yet. Check the server and try again.';
    return;
  }
  state.callsign = callsign;
  $('crewTag').textContent = `Crew ${callsign}`; // textContent: never parsed as HTML
  $('crewTag').hidden = false;
  show('screenPlanner');
  mountMap();
};

// ---------------------------------------------------------------------------
// Loading data from the API (region, config) and the target catalog.
// ---------------------------------------------------------------------------
async function loadTargets() {
  const response = await fetch('/map-data/targets.geojson');
  if (!response.ok) throw new Error('Science target catalog unavailable.');
  const catalog = await response.json();
  return new Map(catalog.features.map(({ geometry, properties }) => {
    const [lon, lat] = geometry.coordinates;
    return [properties.id, { ...properties, lat, lon }];
  }));
}

async function loadEverything() {
  try {
    const [config, region, targets] = await Promise.all([api.getConfig(), api.getRegion(), loadTargets()]);
    state.config = config.config;
    state.region = region;
    state.targets = targets;
  } catch (error) {
    $('setupError').textContent = `Cannot load mission data: ${error.message}`;
  }
  renderRegionCards();
}

// ---------------------------------------------------------------------------
// The map: NASA imagery + traverse + waypoints (from the team's adapter),
// plus our base, target, route and rover layers.
// ---------------------------------------------------------------------------
async function mountMap() {
  if (state.map) return renderTargetList();
  try {
    state.map = await mountMarsMap({
      container: $('marsMap'),
      region: state.region,
      onSelect: (point, properties) => showWaypoint(point, properties),
      onStatus: (message) => { $('mapStatus').textContent = message + ' (observed NASA data)'; },
    });
  } catch (error) {
    $('mapStatus').textContent = 'Map unavailable: ' + error.message;
    return;
  }
  const map = state.map.getMap();
  L.control.zoom({ position: 'topleft' }).addTo(map);

  state.layers.route = L.layerGroup().addTo(map);
  state.layers.targets = L.layerGroup().addTo(map);

  // Base: a simulated scenario element at a real place.
  const { base } = state.region;
  L.circleMarker([base.lat, base.lon], { radius: 10, color: '#ffd38a', weight: 3, fillColor: '#3a2a14', fillOpacity: 1 })
    .bindTooltip(`${base.label} · SIMULATED base`, { permanent: false })
    .addTo(state.layers.targets);

  for (const target of state.targets.values()) {
    L.circleMarker([target.lat, target.lon], { radius: 11, color: '#7ff0d9', weight: 3, fillColor: '#0e3b37', fillOpacity: 0.95 })
      .bindTooltip(`Science target: ${target.name}`)
      .on('click', () => selectTarget(target.id))
      .addTo(state.layers.targets);
  }
  recenter();
  renderTargetList();
}

function recenter() {
  const map = state.map?.getMap();
  if (!map) return;
  if (state.mission?.position) {
    map.setView([state.mission.position[1], state.mission.position[0]], Math.max(map.getZoom(), 15));
  } else {
    const points = [[state.region.base.lat, state.region.base.lon], ...[...state.targets.values()].map((t) => [t.lat, t.lon])];
    map.fitBounds(points, { padding: [60, 60], maxZoom: 15 });
  }
}
$('recenter').onclick = recenter;

// Draw a candidate's outbound (solid) and return (dashed) lines.
function drawRoute(candidate, { preview = false } = {}) {
  const group = state.layers.route;
  if (!group) return;
  group.clearLayers();
  const toLatLng = ([lon, lat]) => [lat, lon];
  if (candidate.geometry.length > 1) {
    L.polyline(candidate.geometry.map(toLatLng), { color: preview ? '#c9b8ff' : '#ffe45c', weight: 6, opacity: 0.95 }).addTo(group);
  }
  if (candidate.returnGeometry.length > 1) {
    L.polyline(candidate.returnGeometry.map(toLatLng), { color: '#ffffff', weight: 3, opacity: 0.9, dashArray: '6 8' }).addTo(group);
  }
}

// ---------------------------------------------------------------------------
// Side panel content helpers.
// ---------------------------------------------------------------------------
const panel = () => $('panel');
function setPanel(...children) {
  panel().replaceChildren(...children);
  panel().scrollTop = 0;
}

// ---------------------------------------------------------------------------
// 3. Explore: target list, target inspector, waypoint inspector.
// ---------------------------------------------------------------------------
function renderTargetList() {
  if (state.mission) return;
  setPanel(
    el('p', { class: 'eyebrow' }, 'Jezero Crater · explore'),
    el('h2', {}, 'Choose a science target'),
    el('p', { class: 'muted' }, 'The cyan line is the path NASA\'s Perseverance rover really drove. Our simulated crew can only plan along it. Click a target (or any NASA waypoint) on the map.'),
    ...[...state.targets.values()].map((target) =>
      el('button', { class: 'list-item', onclick: () => selectTarget(target.id) },
        el('b', {}, target.name),
        el('small', {}, `Sol ${target.sol} · science value ${target.scienceValue}/3 · ${target.stopMinutes} min stop`))),
  );
}

function selectTarget(id) {
  if (state.mission) return; // during a mission, stops are proposed from the mission panel
  const target = state.targets.get(id);
  state.selectedTargetId = id;
  state.map?.getMap().flyTo([target.lat, target.lon], 16, { duration: 0.6 });
  state.layers.route?.clearLayers();

  const image = target.imageUrl
    ? el('figure', { class: 'target-photo' },
        el('img', { src: target.imageUrl, alt: `NASA Navcam image, sol ${target.sol}`, loading: 'lazy' }),
        el('figcaption', {}, `Perseverance Navcam, sol ${target.sol}. Credit: ${target.imageCredit ?? 'NASA/JPL-Caltech'}. `,
          'Image matched to this waypoint by its site/drive id in the file name.'))
    : el('p', { class: 'fine' }, 'No verified image for this exact point. Use the NASA gallery link below.');

  setPanel(
    el('button', { class: 'link', onclick: () => { state.selectedTargetId = null; renderTargetList(); } }, '← All targets'),
    el('p', { class: 'eyebrow' }, 'Science target'),
    el('h2', {}, target.name),
    image,
    el('dl', { class: 'facts' },
      fact('Coordinates', `${target.lat.toFixed(6)}° N, ${target.lon.toFixed(6)}° E`, 'OBSERVED'),
      fact('Waypoint id (site_drive)', `${target.id} · sol ${target.sol}`, 'OBSERVED'),
      fact('Science value', `${target.scienceValue} / 3`, 'EDITORIAL'),
      fact('Planned stop', `${target.stopMinutes} min`, 'EDITORIAL')),
    el('p', {}, target.summary),
    el('p', { class: 'muted' }, el('b', {}, 'Why it matters: '), target.scienceRationale),
    el('p', { class: 'fine' }, 'Science value is the team\'s 1-3 editorial rubric, not a NASA measurement.'),
    el('div', { class: 'links' }, ...(target.sourceUrls ?? []).map((url) =>
      el('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Source ↗'))),
    el('button', { class: 'primary', onclick: () => compareRoutes(id) }, 'Compare routes from base →'),
  );
}

function fact(label, value, kind) {
  return el('div', {}, el('dt', {}, label, ' ', tag(kind)), el('dd', {}, value));
}

function showWaypoint(point, properties) {
  if (state.mission) return;
  if (state.targets.has(properties.RMC)) return selectTarget(properties.RMC);
  const value = (v, unit, scale = 1, digits = 1) => (Number.isFinite(v) ? `${(v / scale).toFixed(digits)} ${unit}` : 'not recorded');
  setPanel(
    el('button', { class: 'link', onclick: renderTargetList }, '← All targets'),
    el('p', { class: 'eyebrow' }, 'NASA waypoint'),
    el('h2', {}, `Sol ${properties.sol} · ${properties.RMC}`),
    el('dl', { class: 'facts' },
      fact('Coordinates', `${point.lat.toFixed(6)}° N, ${point.lon.toFixed(6)}° E`, 'OBSERVED'),
      fact('Elevation (units/datum unverified)', value(properties.elev_geoid, 'm'), 'OBSERVED'),
      fact('Total rover distance', value(properties.dist_total_m, 'km', 1000, 2), 'OBSERVED')),
    el('p', { class: 'muted' }, properties.Note || 'NASA supplied no localization note.'),
    el('p', { class: 'fine' }, 'Route planning is available for the three listed science targets.'),
    el('a', { href: `https://mars.nasa.gov/mars2020/multimedia/raw-images/?begin_sol=${properties.sol}&end_sol=${properties.sol}`, target: '_blank', rel: 'noopener noreferrer' }, `NASA raw images from sol ${properties.sol} ↗`),
  );
}

// ---------------------------------------------------------------------------
// Talking to the route engine.
// ---------------------------------------------------------------------------
// Builds a RouteRequest (brief section 7). Budgets come from the simulated
// mission if one is running, otherwise the full starting budget from config.
function routeRequest({ origin, destination, stopIds = [] }) {
  const { region, config, mission } = state;
  return {
    requestId: crypto.randomUUID(),
    regionId: region.id,
    dataVersion: region.dataVersion,
    origin,
    destination,
    base: { lat: region.base.lat, lon: region.base.lon },
    stopIds,
    remainingMinutes: mission ? Math.max(0, config.missionDurationMinutes - mission.elapsedMin) : config.missionDurationMinutes,
    currentBatteryKWh: mission ? Math.max(0, mission.batteryKWh) : (config.batteryCapacityKWh * config.startChargePercent) / 100,
  };
}

const basePoint = () => ({ lat: state.region.base.lat, lon: state.region.base.lon });
const targetPoint = (id) => ({ lat: state.targets.get(id).lat, lon: state.targets.get(id).lon });

// ---------------------------------------------------------------------------
// 4. Compare routes (engine) and explain the recommendation.
// ---------------------------------------------------------------------------
async function compareRoutes(targetId) {
  const target = state.targets.get(targetId);
  setPanel(el('p', { class: 'eyebrow' }, 'Route comparison'), el('h2', {}, `Base → ${target.name}`), el('p', { class: 'muted' }, 'Asking the route engine…'));
  let result;
  try {
    result = await api.planRoutes(routeRequest({ origin: basePoint(), destination: targetPoint(targetId) }));
  } catch (error) {
    return setPanel(el('h2', {}, 'Route engine error'), el('p', { class: 'error' }, error.message),
      el('button', { onclick: () => selectTarget(targetId) }, '← Back'));
  }
  if (!result) return; // a newer request replaced this one

  const mains = result.candidates.filter((c) => !isDetour(c));
  const eligible = mains.filter((c) => c.feasibility === 'pass');
  const others = mains.filter((c) => c.feasibility !== 'pass');
  const detours = result.candidates.filter(isDetour);
  if (eligible[0]) drawRoute(eligible[0]);
  else if (mains[0]) drawRoute(mains[0], { preview: true });

  setPanel(
    el('button', { class: 'link', onclick: () => selectTarget(targetId) }, '← Target'),
    el('p', { class: 'eyebrow' }, 'Route comparison · engine results ', tag('DERIVED')),
    el('h2', {}, `Base → ${target.name}`),
    el('p', { class: 'muted' }, eligible.length
      ? `${eligible.length} route${eligible.length > 1 ? 's' : ''} passed every check, including the trip home. The recommended route is first.`
      : 'No route passed every check. The engine\'s reasons are below.'),
    ...eligible.map((c, i) => candidateCard(c, { startable: true, title: i === 0 ? 'Recommended route' : 'Alternative', targetId })),
    ...result.errors.map((message) => el('p', { class: 'error' }, message)),
    detours.length ? el('h3', {}, 'Science detour suggestions') : null,
    detours.length ? el('p', { class: 'fine' }, 'The engine checked these optional extra stops with the full round trip. You can propose one while driving.') : null,
    ...detours.map((c) => candidateCard(c, { startable: false, title: 'Optional science detour' })),
    others.length ? el('details', { class: 'other-routes' },
      el('summary', {}, `Not eligible: ${others.length} other route${others.length > 1 ? 's' : ''} (blocked or unverified preview)`),
      ...others.map((c) => candidateCard(c, { startable: false, title: c.feasibility === 'blocked' ? 'Blocked' : 'Unverified preview' }))) : null,
  );
}

// One route card. Every number on it is the engine's.
function candidateCard(candidate, { startable, title, targetId, onStart }) {
  const roles = rolesOf(candidate);
  const reserve = findReason(candidate, 'Return reserve:');
  const card = el('article', { class: `card verdict-${candidate.feasibility}` },
    el('header', {},
      el('b', {}, roles.length ? roles.join(' · ') : title),
      el('span', { class: `verdict ${candidate.feasibility}` }, candidate.feasibility.toUpperCase())),
    el('dl', { class: 'metrics' },
      metric('Distance out', fmt(candidate.distanceKm, 2, 'km')),
      metric('Drive out', fmt(candidate.driveMinutes, 1, 'min')),
      metric('Science stops', fmt(candidate.stopMinutes, 0, 'min')),
      metric('Drive back', fmt(candidate.returnMinutes, 1, 'min')),
      metric('Energy (round trip)', fmt(candidate.totalEnergyKWh, 2, 'kWh')),
      metric('Science value', `${candidate.scienceValue}`),
      // A zero-distance plan has no terrain score (N/A), which is not "unknown".
      metric('Terrain score S', candidate.distanceKm === 0 ? 'N/A (no outbound driving)' : fmt(candidate.safetyScore, 0)),
      metric('Time score U', fmt(candidate.timeScore, 0)),
      metric('Overall C (70/30)', candidate.distanceKm === 0 ? 'N/A' : fmt(candidate.overallScore, 1)),
      metric('Slope data coverage', fmt(candidate.coveragePercent, 0, '%'))),
    reserve ? el('p', { class: 'reserve' }, reserve) : null,
    el('ul', { class: 'reasons' }, ...keyReasons(candidate).filter((r) => r !== reserve).map((r) => el('li', {}, r))),
    el('details', {}, el('summary', {}, 'All engine reasons'),
      el('ul', { class: 'reasons all' }, ...candidate.reasons.map((r) => el('li', {}, r))),
      el('p', { class: 'fine' }, `Candidate id ${candidate.id}`)),
  );
  card.addEventListener('mouseenter', () => drawRoute(candidate, { preview: candidate.feasibility !== 'pass' }));
  if (startable && candidate.feasibility === 'pass') {
    card.append(el('button', { class: 'primary', onclick: () => (onStart ?? (() => startMission(candidate, targetId)))() }, 'Start simulated drive on this route →'));
  }
  return card;
}

function metric(label, value) {
  return el('div', {}, el('dt', {}, label), el('dd', {}, value));
}

// ---------------------------------------------------------------------------
// 5. The simulated mission.
// ---------------------------------------------------------------------------
// Simulation speed: simulated minutes per real second, at 1x.
const SIM_MINUTES_PER_SECOND = 1;

// Cumulative position along a geometry, for ANIMATION ONLY (placing the
// rover marker). Route distances and times always come from the engine.
function animationProfile(geometry) {
  const cumulative = [0];
  for (let i = 1; i < geometry.length; i++) {
    const [x1, y1] = geometry[i - 1];
    const [x2, y2] = geometry[i];
    cumulative.push(cumulative[i - 1] + Math.hypot((x2 - x1) * Math.cos((y1 * Math.PI) / 180), y2 - y1));
  }
  return cumulative;
}

// Where along the geometry (0..1) a target sits: the vertex closest to it.
function fractionOfTarget(geometry, profile, id) {
  const t = state.targets.get(id);
  let best = 0;
  let bestD = Infinity;
  geometry.forEach(([lon, lat], i) => {
    const d = Math.hypot(lon - t.lon, lat - t.lat);
    if (d < bestD) { bestD = d; best = i; }
  });
  const total = profile.at(-1) || 1;
  return profile[best] / total;
}

// Load a plan (a candidate) as the active OUTBOUND leg.
// stopIds: the intermediate stops in order; finalId: the destination target.
function loadOutboundLeg(candidate, stopIds, finalId) {
  const m = state.mission;
  const geometry = candidate.geometry;
  const profile = animationProfile(geometry);
  m.plan = candidate;
  m.leg = 'outbound';
  m.geometry = geometry;
  m.profile = profile;
  m.legDriveMinutes = candidate.driveMinutes;
  m.drivenMin = 0;
  m.dwellMin = 0;
  m.finalId = finalId;
  // Driving energy per driven minute on this leg (engine kWh / engine minutes).
  m.driveKWhPerMin = candidate.driveMinutes > 0 ? candidate.outboundEnergyKWh / candidate.driveMinutes : 0;
  m.stops = [...stopIds, finalId].map((id) => ({
    id,
    fraction: fractionOfTarget(geometry, profile, id),
    stopMinutes: state.targets.get(id).stopMinutes,
    done: false,
  }));
  m.routeRevision += 1;
  drawRoute(candidate);
}

function loadReturnLeg(candidate) {
  const m = state.mission;
  m.plan = candidate;
  m.leg = 'return';
  m.geometry = candidate.returnGeometry;
  m.profile = animationProfile(m.geometry);
  m.legDriveMinutes = candidate.returnMinutes;
  m.drivenMin = 0;
  m.dwellMin = 0;
  m.stops = [];
  m.driveKWhPerMin = candidate.returnMinutes > 0 ? candidate.returnEnergyKWh / candidate.returnMinutes : 0;
  m.routeRevision += 1;
  drawRoute({ geometry: [], returnGeometry: candidate.returnGeometry });
}

function startMission(candidate, targetId) {
  const { config } = state;
  state.mission = {
    phase: 'navigating',      // navigating | paused | arrived | returning | complete
    elapsedMin: 0,
    batteryKWh: (config.batteryCapacityKWh * config.startChargePercent) / 100,
    speed: 1,
    paused: false,
    visited: [],
    routeRevision: 0,
    acceptedChanges: [],
    rejectedProposals: [],
    plannedDistanceKm: candidate.distanceKm,
    startPlan: candidate,
  };
  loadOutboundLeg(candidate, [], targetId);
  state.mission.position = candidate.geometry[0];
  ensureRover();
  state.map.getMap().setView([candidate.geometry[0][1], candidate.geometry[0][0]], 16);
  renderMissionPanel();
  lastFrame = performance.now();
  requestAnimationFrame(frame);
}

// The rover marker (simulated position).
function ensureRover() {
  if (!state.layers.rover) {
    state.layers.rover = L.circleMarker([0, 0], { radius: 9, color: '#ffffff', weight: 3, fillColor: '#ff7a45', fillOpacity: 1 })
      .bindTooltip('Rover (SIMULATED position)')
      .addTo(state.map.getMap());
  }
  updateRover();
}

function updateRover() {
  const m = state.mission;
  if (!m || !state.layers.rover) return;
  state.layers.rover.setLatLng([m.position[1], m.position[0]]);
}

// Position (a geometry vertex) at a fraction (0..1) of the leg. We use a real
// vertex, so a re-plan from here starts exactly on the traverse.
function vertexAtFraction(m, fraction) {
  const total = m.profile.at(-1) || 0;
  const goal = fraction * total;
  let i = 0;
  while (i < m.profile.length - 1 && m.profile[i + 1] <= goal) i++;
  return m.geometry[i];
}

let lastFrame = 0;
function frame(now) {
  const m = state.mission;
  if (!m || m.phase === 'complete') return;
  const dtSeconds = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;
  if (!m.paused && (m.phase === 'navigating' || m.phase === 'returning')) {
    advance(dtSeconds * SIM_MINUTES_PER_SECOND * m.speed);
    updateLive();
  }
  requestAnimationFrame(frame);
}

// Spend `dt` simulated minutes: either dwelling at a science stop or driving.
function advance(dt) {
  const m = state.mission;
  const auxKWhPerMin = state.config.auxiliaryKW / 60;
  while (dt > 1e-9 && !m.paused) {
    if (m.dwellMin > 0) {
      const step = Math.min(dt, m.dwellMin);
      m.dwellMin -= step;
      m.elapsedMin += step;
      m.batteryKWh -= auxKWhPerMin * step;
      dt -= step;
      if (m.dwellMin <= 1e-9) {
        const stop = m.stops.find((s) => s.dwelling);
        stop.dwelling = false;
        stop.done = true;
        m.visited.push(stop.id);
        notice(`Science stop complete: ${state.targets.get(stop.id).name}.`);
      }
      continue;
    }
    // Next stop not done yet (in order).
    const next = m.stops.find((s) => !s.done);
    const legFraction = m.legDriveMinutes > 0 ? m.drivenMin / m.legDriveMinutes : 1;
    const stopAt = next ? next.fraction : 1;
    const minutesToGoal = Math.max(0, (stopAt - legFraction) * m.legDriveMinutes);
    const step = Math.min(dt, minutesToGoal);
    m.drivenMin += step;
    m.elapsedMin += step;
    m.batteryKWh -= (m.driveKWhPerMin + auxKWhPerMin) * step;
    dt -= step;
    const fraction = m.legDriveMinutes > 0 ? Math.min(1, m.drivenMin / m.legDriveMinutes) : 1;
    m.position = vertexAtFraction(m, fraction);
    updateRover();

    if (step >= minutesToGoal - 1e-9) {
      if (next) {
        next.dwelling = true;
        m.dwellMin = next.stopMinutes;
        notice(`Arrived at ${state.targets.get(next.id).name}: ${next.stopMinutes} min science stop.`);
        m.position = vertexAtFraction(m, next.fraction);
      } else {
        // End of the leg.
        m.position = m.geometry.at(-1);
        updateRover();
        if (m.leg === 'outbound') { m.phase = 'arrived'; renderArrival(); }
        else { m.phase = 'complete'; renderSummary(); }
        return;
      }
    }
    // Budget exhausted: pause with a warning (never a negative battery).
    if (m.batteryKWh <= 0 || m.elapsedMin >= state.config.missionDurationMinutes) {
      m.paused = true;
      m.batteryKWh = Math.max(0, m.batteryKWh);
      notice('Mission budget exhausted: simulation paused.');
      renderMissionPanel();
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Mission panel (navigation HUD).
// ---------------------------------------------------------------------------
function renderMissionPanel(extra = null) {
  const m = state.mission;
  const next = m.stops.find((s) => !s.done);
  const reserve = findReason(m.plan, 'Return reserve:');
  setPanel(
    el('p', { class: 'eyebrow' }, m.leg === 'return' ? 'Returning to base' : 'Navigating · simulated drive ', tag('SIMULATED')),
    el('h2', {}, m.leg === 'return' ? `→ ${state.region.base.label}` : `→ ${state.targets.get(m.finalId).name}`),
    el('dl', { class: 'live' },
      liveRow('Mission time used', 'liveElapsed'),
      liveRow('Mission time left', 'liveRemaining'),
      liveRow('Battery', 'liveBattery'),
      liveRow('Leg progress', 'liveProgress'),
      liveRow('Next stop', 'liveNext')),
    el('div', { class: 'battery-bar' }, el('i', { id: 'liveBatteryBar' })),
    el('p', { class: 'reserve' }, el('b', {}, 'Active plan (engine): '), reserve ?? 'unknown', ' ', tag('DERIVED')),
    el('div', { class: 'controls' },
      el('button', { id: 'pauseBtn', onclick: togglePause }, m.paused ? '▶ Resume' : '⏸ Pause'),
      el('button', { onclick: cycleSpeed }, `Speed ${m.speed}×`),
      el('button', { onclick: recenter }, '⌖ Recenter')),
    m.leg === 'outbound' ? el('div', { class: 'controls' },
      el('button', { class: 'accent', onclick: openProposals }, '＋ Propose science stop'),
      el('button', { onclick: () => planReturn('Return to base requested.') }, '⌂ Return to base')) : null,
    extra,
    el('p', { class: 'fine' }, 'Playback speed changes how fast the simulation runs, not the route cost. Time and battery are spent at the engine\'s rates for the active plan.'),
  );
  updateLive();
}

function liveRow(label, id) {
  return el('div', {}, el('dt', {}, label), el('dd', { id }, '—'));
}

function updateLive() {
  const m = state.mission;
  if (!m || !$('liveElapsed')) return;
  const { config } = state;
  const next = m.stops.find((s) => !s.done);
  $('liveElapsed').textContent = `${m.elapsedMin.toFixed(1)} min`;
  $('liveRemaining').textContent = `${Math.max(0, config.missionDurationMinutes - m.elapsedMin).toFixed(1)} of ${config.missionDurationMinutes} min`;
  $('liveBattery').textContent = `${Math.max(0, m.batteryKWh).toFixed(2)} of ${config.batteryCapacityKWh} kWh`;
  $('liveProgress').textContent = m.legDriveMinutes > 0 ? `${Math.min(100, (100 * m.drivenMin) / m.legDriveMinutes).toFixed(0)}%` : '100%';
  $('liveNext').textContent = m.dwellMin > 0
    ? `At ${state.targets.get(m.stops.find((s) => s.dwelling).id).name} (${m.dwellMin.toFixed(1)} min left)`
    : next ? state.targets.get(next.id).name : (m.leg === 'return' ? 'Base' : 'Destination');
  $('liveBatteryBar').style.width = `${Math.max(0, (100 * m.batteryKWh) / config.batteryCapacityKWh)}%`;
}

function togglePause() {
  const m = state.mission;
  m.paused = !m.paused;
  lastFrame = performance.now();
  $('pauseBtn').textContent = m.paused ? '▶ Resume' : '⏸ Pause';
}

function cycleSpeed() {
  const m = state.mission;
  m.speed = m.speed === 1 ? 3 : m.speed === 3 ? 10 : 1;
  renderMissionPanel();
}

function notice(message) {
  const n = el('div', { class: 'toast', role: 'status' }, message);
  document.body.append(n);
  setTimeout(() => n.remove(), 4000);
}

// ---------------------------------------------------------------------------
// 6. Propose a science stop while paused (engine re-plan, accept/cancel).
// ---------------------------------------------------------------------------
const remainingStopIds = (m) => m.stops.filter((s) => !s.done && s.id !== m.finalId).map((s) => s.id);
const currentPoint = (m) => ({ lat: m.position[1], lon: m.position[0] });

function openProposals() {
  const m = state.mission;
  m.paused = true;
  const planned = new Set([...m.visited, ...m.stops.map((s) => s.id)]);
  const options = [...state.targets.values()].filter((t) => !planned.has(t.id));
  renderMissionPanel(el('section', { class: 'proposal' },
    el('h3', {}, 'Propose a science stop (paused)'),
    options.length
      ? el('div', {}, ...options.map((t) => el('button', { class: 'list-item', onclick: () => proposeStop(t.id) },
          el('b', {}, t.name), el('small', {}, `Science ${t.scienceValue}/3 · ${t.stopMinutes} min stop`))))
      : el('p', { class: 'muted' }, 'No other listed targets.'),
    el('button', { class: 'link', onclick: () => renderMissionPanel() }, 'Cancel')));
}

// Ask the engine for (1) the current plan from here and (2) the plan with the
// new stop. Try "new stop beyond the current destination" first, then "new
// stop on the way". Nothing changes until the crew accepts.
async function proposeStop(newId) {
  const m = state.mission;
  const revision = m.routeRevision;
  const here = currentPoint(m);
  const stops = remainingStopIds(m);
  renderMissionPanel(el('p', { class: 'muted' }, `Asking the route engine about ${state.targets.get(newId).name}…`));

  try {
    const current = await api.planRoutes(routeRequest({ origin: here, destination: targetPoint(m.finalId), stopIds: stops }));
    let proposal = await api.planRoutes(routeRequest({ origin: here, destination: targetPoint(newId), stopIds: [...stops, m.finalId] }));
    let order = { stopIds: [...stops, m.finalId], finalId: newId };
    if (proposal && proposal.candidates.length === 0) {
      const onTheWay = await api.planRoutes(routeRequest({ origin: here, destination: targetPoint(m.finalId), stopIds: [...stops, newId] }));
      if (onTheWay && onTheWay.candidates.length > 0) {
        proposal = onTheWay;
        order = { stopIds: [...stops, newId], finalId: m.finalId };
      }
    }
    if (!current || !proposal || m.routeRevision !== revision) return; // stale
    showProposal(newId, current, proposal, order);
  } catch (error) {
    renderMissionPanel(el('p', { class: 'error' }, `Route engine error: ${error.message}`));
  }
}

function showProposal(newId, current, proposal, order) {
  const target = state.targets.get(newId);
  const now = current.candidates.find((c) => !isDetour(c)) ?? null;
  const mains = proposal.candidates.filter((c) => !isDetour(c));
  const best = mains[0] ?? null; // engine order: recommended first, then blocked, then unverified
  const nowReserve = now ? findReason(now, 'Return reserve:') : 'unknown';
  if (best) drawRoute(best, { preview: true });

  const accepted = best?.feasibility === 'pass';
  const problems = best ? best.reasons.filter((r) => r.startsWith('Not enough') || r.includes('exceeds') || r.startsWith('No return path')) : [];
  const section = el('section', { class: `proposal ${accepted ? 'ok' : 'rejected'}` },
    el('h3', {}, `Proposal: add ${target.name}`),
    el('p', {}, 'Science value ', `${target.scienceValue}/3 `, tag('EDITORIAL'), ` · ${target.stopMinutes} min stop`),
    el('dl', { class: 'compare' },
      el('div', {}, el('dt', {}, 'Current plan ', tag('DERIVED')), el('dd', {}, nowReserve ?? 'unknown')),
      el('div', {}, el('dt', {}, 'With this stop ', tag('DERIVED')), el('dd', {}, best ? (findReason(best, 'Return reserve:') ?? 'unknown') : 'no route'))),
    best ? el('p', {}, el('span', { class: `verdict ${best.feasibility}` }, best.feasibility.toUpperCase()),
      accepted ? ' The engine says this stop still leaves enough time and battery to get home.' : ' The engine rejected this change:') : null,
    ...problems.map((r) => el('p', { class: 'error' }, r)),
    ...proposal.errors.map((r) => el('p', { class: 'error' }, r)),
    best ? el('details', {}, el('summary', {}, 'Full engine result for this proposal'), candidateCard(best, { startable: false, title: 'Proposed plan' })) : null,
    el('div', { class: 'controls' },
      accepted ? el('button', { class: 'primary', onclick: () => acceptProposal(best, order, newId) }, 'Accept new plan') : null,
      el('button', { onclick: cancelProposal }, accepted ? 'Cancel (keep current plan)' : 'Keep current plan'),
      accepted ? null : el('button', { onclick: () => planReturn('Returning to base instead.') }, '⌂ Return to base instead')));
  if (!accepted) state.mission.rejectedProposals.push({ id: newId, reason: problems[0] ?? proposal.errors[0] ?? 'No feasible route.' });
  renderMissionPanel(section);
}

function cancelProposal() {
  const m = state.mission;
  drawRoute(m.plan);
  renderMissionPanel();
}

function acceptProposal(candidate, order, newId) {
  const m = state.mission;
  m.acceptedChanges.push({ id: newId, reserve: findReason(candidate, 'Return reserve:') });
  loadOutboundLeg(candidate, order.stopIds, order.finalId);
  m.position = candidate.geometry[0];
  m.paused = false;
  lastFrame = performance.now();
  notice(`New plan accepted: ${state.targets.get(newId).name} added.`);
  renderMissionPanel();
}

// ---------------------------------------------------------------------------
// 7. Arrival, return to base (engine), mission summary.
// ---------------------------------------------------------------------------
function renderArrival() {
  const m = state.mission;
  const target = state.targets.get(m.finalId);
  setPanel(
    el('p', { class: 'eyebrow' }, 'Arrived'),
    el('h2', {}, target.name),
    target.imageUrl ? el('figure', { class: 'target-photo' }, el('img', { src: target.imageUrl, alt: `NASA Navcam image, sol ${target.sol}` }),
      el('figcaption', {}, `Credit: ${target.imageCredit ?? 'NASA/JPL-Caltech'}`)) : null,
    el('p', {}, target.summary),
    el('p', { class: 'muted' }, target.scienceRationale),
    el('dl', { class: 'live' },
      el('div', {}, el('dt', {}, 'Mission time used ', tag('SIMULATED')), el('dd', {}, `${m.elapsedMin.toFixed(1)} min`)),
      el('div', {}, el('dt', {}, 'Battery ', tag('SIMULATED')), el('dd', {}, `${m.batteryKWh.toFixed(2)} kWh`)),
      el('div', {}, el('dt', {}, 'Stops completed'), el('dd', {}, m.visited.map((id) => state.targets.get(id).name).join(', ') || 'none'))),
    el('button', { class: 'primary', onclick: () => planReturn('Planning the drive home.') }, 'Plan return to base →'),
  );
}

async function planReturn(message) {
  const m = state.mission;
  m.paused = true;
  notice(message);
  try {
    const result = await api.planRoutes(routeRequest({ origin: currentPoint(m), destination: basePoint() }));
    if (!result) return;
    const home = result.candidates.find((c) => c.feasibility === 'pass') ?? result.candidates[0];
    if (!home) {
      return setPanel(el('h2', {}, 'No way home found'), ...result.errors.map((e) => el('p', { class: 'error' }, e)));
    }
    drawRoute({ geometry: [], returnGeometry: home.returnGeometry });
    setPanel(
      el('p', { class: 'eyebrow' }, 'Return to base · engine plan ', tag('DERIVED')),
      el('h2', {}, `→ ${state.region.base.label}`),
      candidateCard(home, { startable: false, title: 'Return route' }),
      home.feasibility === 'pass' || home.feasibility === 'blocked'
        ? el('button', { class: 'primary', onclick: () => startReturn(home) }, 'Drive home (follows the traverse) →')
        : el('p', { class: 'error' }, 'The return could not be verified; see the reasons above.'),
    );
  } catch (error) {
    setPanel(el('h2', {}, 'Route engine error'), el('p', { class: 'error' }, error.message),
      el('button', { onclick: () => planReturn(message) }, 'Try again'));
  }
}

function startReturn(home) {
  const m = state.mission;
  m.returnPlan = home;
  loadReturnLeg(home);
  m.phase = 'returning';
  m.paused = false;
  lastFrame = performance.now();
  renderMissionPanel();
}

function renderSummary() {
  const m = state.mission;
  const science = m.visited.reduce((sum, id) => sum + (state.targets.get(id).scienceValue ?? 0), 0);
  setPanel(
    el('p', { class: 'eyebrow' }, 'Mission complete'),
    el('h2', {}, `Welcome home, ${state.callsign}`),
    el('dl', { class: 'live' },
      el('div', {}, el('dt', {}, 'Science stops'), el('dd', {}, m.visited.map((id) => state.targets.get(id).name).join(', ') || 'none')),
      el('div', {}, el('dt', {}, 'Science value collected ', tag('EDITORIAL')), el('dd', {}, `${science}`)),
      el('div', {}, el('dt', {}, 'Mission time used ', tag('SIMULATED')), el('dd', {}, `${m.elapsedMin.toFixed(1)} of ${state.config.missionDurationMinutes} min`)),
      el('div', {}, el('dt', {}, 'Battery left ', tag('SIMULATED')), el('dd', {}, `${m.batteryKWh.toFixed(2)} kWh (reserve ${(state.config.batteryCapacityKWh * state.config.batteryReservePercent) / 100} kWh)`)),
      el('div', {}, el('dt', {}, 'Plan changes accepted'), el('dd', {}, m.acceptedChanges.map((c) => state.targets.get(c.id).name).join(', ') || 'none')),
      el('div', {}, el('dt', {}, 'Proposals rejected by the engine'), el('dd', {}, m.rejectedProposals.map((r) => `${state.targets.get(r.id).name}: ${r.reason}`).join(' · ') || 'none'))),
    el('p', { class: 'fine' }, 'Simulated scenario on NASA\'s real Perseverance traverse. Not a validated navigation system.'),
    el('button', { class: 'primary', onclick: resetMission }, 'New mission'),
  );
}

function resetMission() {
  state.mission = null;
  state.layers.route?.clearLayers();
  if (state.layers.rover) { state.layers.rover.remove(); state.layers.rover = null; }
  recenter();
  renderTargetList();
}

// ---------------------------------------------------------------------------
// Sources, assumptions and limitations.
// ---------------------------------------------------------------------------
function renderSources() {
  const c = state.config ?? {};
  const link = (href, text) => el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
  $('sourcesBody').replaceChildren(
    el('h2', {}, 'Sources, assumptions & limits'),
    el('h3', {}, 'What the labels mean'),
    el('ul', {},
      el('li', {}, tag('OBSERVED'), ' NASA mission data: traverse, waypoints, coordinates, images.'),
      el('li', {}, tag('DERIVED'), ' Calculated by our route engine from that data and the assumptions below.'),
      el('li', {}, tag('SIMULATED'), ' The scenario: base, crew, rover position, elapsed time and battery.'),
      el('li', {}, tag('EDITORIAL'), ' The team\'s 1-3 science rubric and stop durations.')),
    el('h3', {}, 'Data and images'),
    el('ul', {},
      el('li', {}, 'Perseverance traverse and waypoints: NASA Mars 2020 mission map layers ', link('https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json', 'traverse ↗'), ' ', link('https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints.json', 'waypoints ↗'), ' (retrieved 13 Nov 2026).'),
      el('li', {}, 'Jezero imagery: ', link('https://trek.nasa.gov/mars/', 'NASA Mars Trek ↗'), ' Jezero CTX mosaic (NASA/JPL-Caltech/MSSS).'),
      el('li', {}, 'Target images and sources: ', link('https://mars.nasa.gov/mars2020/multimedia/raw-images/', 'Perseverance raw images ↗'), ' (NASA/JPL-Caltech) and the links on each target card.'),
      el('li', {}, 'Mars globe: ', link('https://science.nasa.gov/resource/mars-planet-globe/', 'NASA ↗'), '. Map library: Leaflet 1.9.4 (BSD-2-Clause).'),
      el('li', {}, 'Challenge: ', link('https://www.spaceappschallenge.org/2026/challenges/interplanetary-survival-guide-martian-map/?tab=details', 'Interplanetary Survival Guide: Martian Map ↗'))),
    el('h3', {}, 'Prototype assumptions (not rover limits)'),
    el('ul', {},
      el('li', {}, `Flat speed ${c.flatSpeedKmh} km/h; slope limit ${c.maxSlopeDegrees}°; mission ${c.missionDurationMinutes} min with a ${c.minimumTimeReserveMinutes} min reserve.`),
      el('li', {}, `Battery ${c.batteryCapacityKWh} kWh with a ${c.batteryReservePercent}% reserve; driving ${c.baselineKWhPerKm} kWh/km; auxiliary ${c.auxiliaryKW} kW.`),
      el('li', {}, `Score C = ${c.terrainWeight} × terrain score + ${c.timeWeight} × time score. Speed slows and energy rises with slope (team brief formulas).`)),
    el('h3', {}, 'Limitations'),
    el('ul', {},
      el('li', {}, 'Routes follow where the robotic rover actually drove. That is not a computed crewed-rover route and not proof the ground is safe.'),
      el('li', {}, 'Slopes are along-route rise/run over ~50 m. Cross-slope, rocks and sand traps are not captured.'),
      el('li', {}, 'Elevation units and vertical datum are UNVERIFIED.'),
      el('li', {}, 'Unknown terrain makes a route UNVERIFIED (preview only). It is never scored as safe.'),
      el('li', {}, 'The base, crew, rover and its position are a simulated scenario. NASA does not operate this vehicle; nothing here is live telemetry.'),
      el('li', {}, 'No elevation grid was available, so there are no computed alternative routes.')),
    el('h3', {}, 'AI assistance'),
    el('p', {}, 'Parts of the code, tests and documentation were written with AI coding assistants (Claude Code by Anthropic, Codex) under the team\'s direction and review. No images or data were AI-generated.'),
  );
}

$('openSources').onclick = () => { renderSources(); $('sourcesDialog').showModal(); };
$('closeSources').onclick = () => $('sourcesDialog').close();

addEventListener('resize', () => state.map?.resize());
renderRegionCards();
loadEverything();
