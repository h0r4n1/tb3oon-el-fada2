import {mountMarsMap} from './adapters/mars-map.js';
import {createApiClient} from './api-client.js';
const $=s=>document.getElementById(s),c=$('world'),ctx=c.getContext('2d'),mini=$('minimap'),mc=mini.getContext('2d');
let w=innerWidth,h=innerHeight,dpr=Math.min(devicePixelRatio,2),scene='orbit',transition=0,descentStarted=0,running=false,returning=false,finished=false,travel=0,time=0,last=0,chosen=0,detour=false;
let cameraYaw=0,turnStarted=0;
const routes=[{name:'Balanced traverse',tag:'Recommended',score:83,time:28,distance:3.2},{name:'Direct approach',tag:'Fastest',score:73,time:20,distance:2.7},{name:'Discovery loop',tag:'Science first',score:75,time:36,distance:4.1}];
function resize(){w=innerWidth;h=innerHeight;dpr=Math.min(devicePixelRatio,2);c.width=w*dpr;c.height=h*dpr;ctx.setTransform(dpr,0,0,dpr,0,0)}addEventListener('resize',resize);resize();
const noise=(x,z)=>Math.sin(x*.035+z*.013)*12+Math.cos(x*.016-z*.028)*17+Math.sin(x*.009+z*.005)*28;
const road=z=>Math.sin(z*.003)*90+Math.sin(z*.0013)*70;
function terrainY(x,z){let edge=Math.min(1,Math.abs(x-road(z))/100);return noise(x,z)*edge}
function orbit(t){ctx.fillStyle='#07090b';ctx.fillRect(0,0,w,h);for(let i=0;i<170;i++){let x=(Math.sin(i*231.7)+1)*w/2,y=(Math.cos(i*17.43)+1)*h/2;ctx.fillStyle=`rgba(230,231,215,${.15+(i%5)*.12})`;ctx.fillRect(x,y,i%9===0?2:1,1)}let r=Math.min(w,h)*.51,cx=w*.76,cy=h*.58;ctx.save();ctx.beginPath();ctx.arc(cx,cy,r,0,7);ctx.clip();let g=ctx.createRadialGradient(cx-r*.5,cy-r*.5,0,cx,cy,r);g.addColorStop(0,'#c78558');g.addColorStop(.5,'#884d32');g.addColorStop(.85,'#3c231c');g.addColorStop(1,'#100f11');ctx.fillStyle=g;ctx.fillRect(cx-r,cy-r,r*2,r*2);for(let i=0;i<1100;i++){let a=i*2.399,rr=Math.sqrt((i+.5)/1100)*r,x=cx+Math.cos(a+t*.008)*rr,y=cy+Math.sin(a+t*.008)*rr;ctx.fillStyle=i%3?'#2f201b24':'#e3aa7325';ctx.beginPath();ctx.ellipse(x,y,4+(i%17)*1.4,2+(i%11),i,0,7);ctx.fill()}let shade=ctx.createLinearGradient(cx-r,cy,cx+r,cy);shade.addColorStop(0,'#0000');shade.addColorStop(.45,'#0001');shade.addColorStop(1,'#000e');ctx.fillStyle=shade;ctx.fillRect(cx-r,cy-r,r*2,r*2);ctx.restore();ctx.strokeStyle='#daa47d25';ctx.lineWidth=1;ctx.beginPath();ctx.ellipse(cx,cy,r*1.25,r*.23,-.3,0,7);ctx.stroke()}
function surface(t){let sky=ctx.createLinearGradient(0,0,0,h);sky.addColorStop(0,'#342b29');sky.addColorStop(.43,'#b78059');sky.addColorStop(.58,'#d29a68');sky.addColorStop(1,'#412d23');ctx.fillStyle=sky;ctx.fillRect(0,0,w,h);const horizon=h*.41;ctx.fillStyle='#e7bb8220';ctx.beginPath();ctx.arc(w*.76,h*.23,25,0,7);ctx.fill();for(let layer=0;layer<3;layer++){ctx.fillStyle=['#695047','#755447','#846047'][layer];ctx.beginPath();ctx.moveTo(0,horizon+layer*15);for(let x=0;x<=w+20;x+=20)ctx.lineTo(x,horizon-25-Math.sin(x*.009+layer*3)*22-Math.cos(x*.023+layer)*12+layer*16);ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.fill()}
let cameraZ=travel,cameraX=road(cameraZ),alt=scene==='descent'?45+Math.pow(1-transition,3)*650:45;
const cy=Math.cos(cameraYaw),sy=Math.sin(cameraYaw);
function project(x,z,y=0){const dx=x-cameraX,dz=z-cameraZ,depth=dx*sy+dz*cy+50,scale=Math.min(w,h)*.95/Math.max(8,depth);return [w/2+(dx*cy-dz*sy)*scale,horizon+(alt-y)*scale,scale,depth]}
function groundPoint(x,z){const wx=cameraX+x*cy+z*sy,wz=cameraZ-x*sy+z*cy;return project(wx,wz,terrainY(wx,wz))}
for(let z=1800;z>30;z-=35){for(let x=-900;x<950;x+=55){let p=[groundPoint(x,z),groundPoint(x+55,z),groundPoint(x+55,z+35),groundPoint(x,z+35)];let shade=Math.round(55+noise(cameraX+x*cy+z*sy,cameraZ-x*sy+z*cy)*.28+(z/1800)*25);ctx.fillStyle=`rgb(${shade+38},${shade+9},${shade-8})`;ctx.beginPath();p.forEach((v,i)=>i?ctx.lineTo(v[0],v[1]):ctx.moveTo(v[0],v[1]));ctx.closePath();ctx.fill();ctx.strokeStyle='#c98e5720';ctx.lineWidth=.5;ctx.stroke()}}
// Project a luminous route corridor onto the same perspective as the terrain.
for(let z=1300;z>30;z-=20){let z1=cameraZ+z*(returning?-1:1),z2=z1+20*(returning?-1:1);if(finished||turnStarted||z1>tripEnd()||z1<0||z2<0)continue;let p1=project(road(z1)-4,z1,1),p2=project(road(z1)+4,z1,1),p3=project(road(z2)+4,z2,1),p4=project(road(z2)-4,z2,1);ctx.fillStyle=`rgba(171,246,204,${.3+(1-z/1300)*.45})`;ctx.beginPath();[p1,p2,p3,p4].forEach((p,i)=>i?ctx.lineTo(...p.slice(0,2)):ctx.moveTo(...p.slice(0,2)));ctx.closePath();ctx.fill()}
for(let k=1;k<12;k++){let z=cameraZ+(k*110-(travel%110))*(returning?-1:1);if(finished||turnStarted||z>tripEnd()||z<0)continue;let p=project(road(z),z,2),s=p[2]*7;ctx.strokeStyle='#d6ffe5bb';ctx.lineWidth=Math.max(1,p[2]);ctx.beginPath();ctx.moveTo(p[0]-s,p[1]+s*.5);ctx.lineTo(p[0],p[1]);ctx.lineTo(p[0]+s,p[1]+s*.5);ctx.stroke()}
// Fictional lander sits beside the base, leaving the driving corridor clear.
const base=project(road(0)+12,-90,0);
if(base[3]>15){const [bx,by,scale]=base;ctx.save();ctx.translate(bx,by);ctx.scale(scale,scale);ctx.fillStyle='#0005';ctx.beginPath();ctx.ellipse(0,3,24,8,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#aab4ad';ctx.lineWidth=2;for(const side of [-1,1]){ctx.beginPath();ctx.moveTo(side*8,-12);ctx.lineTo(side*20,0);ctx.lineTo(side*26,0);ctx.stroke()}ctx.fillStyle='#d1d3c6';ctx.beginPath();ctx.moveTo(-11,-12);ctx.lineTo(-9,-42);ctx.lineTo(0,-54);ctx.lineTo(9,-42);ctx.lineTo(11,-12);ctx.closePath();ctx.fill();ctx.fillStyle='#233d45';ctx.fillRect(-6,-36,12,8);ctx.fillStyle='#777e78';ctx.fillRect(-11,-19,22,7);ctx.fillStyle='#83f4dc';ctx.fillRect(-3,-45,6,2);ctx.restore();ctx.font='10px monospace';ctx.textAlign='center';ctx.fillStyle='#d5fff1';ctx.fillText('NEBULA BASE / LANDER',bx,by-60*scale-12);ctx.textAlign='left'}
// Rover silhouette is an illustrative vehicle, not a NASA model.
let rw=Math.min(w*.21,220),rh=rw*.48,rx=w/2,ry=h*.79;ctx.save();ctx.translate(rx,ry);ctx.rotate(running?Math.sin(t*3)*.008:0);ctx.fillStyle='#0006';ctx.beginPath();ctx.ellipse(0,rh*.65,rw*.7,rh*.3,0,0,7);ctx.fill();for(const side of [-1,1])for(const yy of [-.2,.35]){ctx.fillStyle='#141817';ctx.fillRect(side*rw*.46-rw*.09,yy*rh,rw*.18,rh*.45);ctx.strokeStyle='#6f7361';for(let n=0;n<5;n++){ctx.beginPath();ctx.moveTo(side*rw*.46-rw*.08,yy*rh+n*rh*.09);ctx.lineTo(side*rw*.46+rw*.08,yy*rh+n*rh*.09);ctx.stroke()}}ctx.fillStyle='#b0b09b';ctx.beginPath();ctx.moveTo(-rw*.35,rh*.45);ctx.lineTo(-rw*.27,-rh*.45);ctx.lineTo(rw*.27,-rh*.45);ctx.lineTo(rw*.35,rh*.45);ctx.closePath();ctx.fill();ctx.fillStyle='#354844';ctx.fillRect(-rw*.22,-rh*.35,rw*.44,rh*.4);ctx.strokeStyle='#dce3c2';ctx.strokeRect(-rw*.22,-rh*.35,rw*.44,rh*.4);ctx.fillStyle='#5d695c';ctx.fillRect(-rw*.28,rh*.12,rw*.56,rh*.23);ctx.fillStyle='#edb681';ctx.fillRect(-rw*.3,rh*.36,rw*.09,5);ctx.fillRect(rw*.21,rh*.36,rw*.09,5);ctx.strokeStyle='#a8b4a2';ctx.beginPath();ctx.moveTo(rw*.23,-rh*.45);ctx.lineTo(rw*.23,-rh);ctx.stroke();ctx.restore()}
function map(){mc.clearRect(0,0,180,180);mc.strokeStyle='#b4dac333';for(let i=0;i<180;i+=30){mc.beginPath();mc.moveTo(i,0);mc.lineTo(i,180);mc.moveTo(0,i);mc.lineTo(180,i);mc.stroke()}mc.strokeStyle='#c3f4df';mc.lineWidth=2;mc.beginPath();for(let i=0;i<=100;i++){let x=90+Math.sin(i*.055)*35,y=155-i*1.3;i?mc.lineTo(x,y):mc.moveTo(x,y)}mc.stroke();let f=Math.min(1,travel/tripEnd());mc.fillStyle='#efffd6';mc.beginPath();mc.arc(90+Math.sin(f*100*.055)*35,155-f*130,5,0,7);mc.fill()}
function update(){let r=routes[chosen];$('speed').textContent=running&&!turnStarted?'05':'00';$('elapsed').textContent=String(Math.floor(time)).padStart(2,'0')+':'+String(Math.floor(time%1*60)).padStart(2,'0');$('battery').innerHTML=`${Math.max(0,100-time*.6).toFixed(0)}<small> %</small>`;$('batteryFill').style.width=Math.max(0,100-time*.6)+'%';$('reserve').innerHTML=`${120-r.time-30-(detour?8:0)-15}<small> MIN</small>`;$('eta').textContent=`${r.time+(detour?8:0)} MIN / ${r.distance} KM`;$('mode').textContent=finished?'ARRIVED':running?'TRAVERSING':time?'PAUSED':'STANDBY';$('go').innerHTML=finished?'ARRIVED ✓':running?'PAUSE DRIVE <span>Ⅱ</span>':time?'RESUME DRIVE <span>▷</span>':'BEGIN DRIVE <span>▷</span>';$('go').disabled=finished||!!turnStarted;$('home').disabled=returning||travel===0;$('tripProgress').textContent=finished?(returning?'BASE REACHED · EXPEDITION COMPLETE':'DESTINATION REACHED · ROVER STOPPED · SELECT RETURN WHEN READY'):(returning?'DESTINATION → BASE · RETURN LEG':`BASE → DESTINATION · ${Math.round(Math.min(100,travel/tripEnd()*100))}%`);if(running&&!turnStarted){let bend=Math.sin(travel*.003+.6);$('arrow').textContent=returning?'↑':bend>0?'↱':'↰';$('instruction').textContent=returning?'Proceed to base lander':bend>0?'Bear gently right':'Bear gently left';$('turnDistance').textContent=returning?`${Math.round(travel)} m to base`:`${Math.round(Math.max(0,tripEnd()-travel))} m to destination`;$('next').textContent=returning?'Follow the projected path to base':'Follow the illuminated path'}map()}
function notify(s){$('notice').textContent=s;$('notice').style.display='block';clearTimeout(window.nt);window.nt=setTimeout(()=>$('notice').style.display='none',4500)}
function cards(){ $('routes').replaceChildren();routes.forEach((r,i)=>{let b=document.createElement('button');b.className='route'+(i===chosen?' selected':'');b.setAttribute('aria-pressed',i===chosen);b.innerHTML=`<div><b>${r.name}</b><small>${r.tag} · ${r.time} min · ${r.distance} km</small></div><strong>${r.score}<small>/ 100</small></strong>`;b.onclick=()=>{chosen=i;cards();update()};$('routes').append(b)})}
$('enter').onclick=()=>{scene='setup';$('intro').hidden=true;$('setup').hidden=false;$('orbitalImage').classList.add('distant');$('setup').classList.remove('focused');$('sectorPanel').classList.remove('revealed');if(marsMap)requestAnimationFrame(()=>marsMap.overview())};$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen()}catch{notify('Use your browser’s full-screen option for an immersive view.')}};$('plan').onclick=()=>{running=false;update();showBriefing(false)};$('close').onclick=()=>$('planner').close();$('confirm').onclick=()=>{$('planner').close();if(scene==='setup'){scene='descent';transition=0;descentStarted=performance.now();$('setup').hidden=true;$('orbitalImage').hidden=true;$('descent').hidden=false;$('destinationName').textContent=$('sectorTitle').textContent.toUpperCase()}else{update();notify('Mission loaded. Resume when ready.')}};$('detour').onclick=()=>{detour=!detour;$('detour').innerHTML=detour?'✓ SCIENCE STOP ADDED <small>+8 min · demo budget updated</small>':'＋ ADD SCIENCE STOP <small>Outcrop study · +8 min</small>';update()};$('go').onclick=()=>{running=!running;update()};$('home').onclick=()=>{if(travel<=0)return;returning=true;running=true;finished=false;turnStarted=performance.now();$('instruction').textContent='Turning toward base';$('arrow').textContent='↶';$('turnDistance').textContent='Reorienting rover';$('next').textContent='Hold position · aligning return heading';$('destinationName').textContent='NEBULA BASE';notify('Turning rover and camera toward the base lander.');update()};
function frame(now){let dt=Math.min((now-last)/1000,.05);last=now;let t=now/1000;if(scene==='orbit'||scene==='setup')orbit(t);else{if(scene==='descent'){transition=Math.min(1,(now-descentStarted)/4000);if(transition===1){scene='surface';$('descent').hidden=true;$('hud').hidden=false;notify('Surface link established. Open MISSION to choose your route.')}}if(turnStarted){let fraction=Math.min(1,(now-turnStarted)/2200);cameraYaw=Math.PI*(fraction*fraction*(3-2*fraction));if(fraction===1)turnStarted=0}if(running&&!turnStarted){travel=Math.max(0,Math.min(tripEnd(),travel+dt*18*(returning?-1:1)));time+=dt*.45;if(returning?travel<=0:travel>=tripEnd()){running=false;finished=true;$('instruction').textContent='Destination reached';$('arrow').textContent='✓';$('turnDistance').textContent=returning?'Welcome home':$('sectorTitle').textContent;$('next').textContent='Rover stopped. Mission control standing by.'}}surface(t);update()}requestAnimationFrame(frame)}cards();requestAnimationFrame(frame);

let selectedPoint = null;
let selectedTarget = null;
let listedTargets = new Map();
let targetCatalogAvailable = false;
let routeCheckPending = false;

function showBriefing(geographic) {
  $('briefTitle').textContent = geographic ? 'Check this destination' : 'Compare routes';
  $('briefTarget').textContent = geographic && selectedTarget ? selectedTarget.name : 'Mission destination';
  if (geographic) showRouteDirection(false);
  $('geographicBriefing').hidden = !geographic;
  $('simulationBriefing').hidden = geographic;
  $('planner').showModal();
}

$('brief').onclick = () => {
  if (!selectedTarget) return;
  if (!$('callsign').value.trim()) {
    $('callsign').focus();
    notify('Enter a crew callsign first.');
    return;
  }
  showBriefing(Boolean(selectedPoint));
};
$('backOrbit').onclick=()=>{scene='orbit';$('setup').hidden=true;$('intro').hidden=false;$('orbitalImage').classList.remove('distant')};$('editSetup').onclick=()=>{if(scene==='setup'){$('planner').close();return}running=false;scene='setup';$('planner').close();$('hud').hidden=true;$('setup').hidden=false;$('orbitalImage').hidden=false;time=0;travel=0;finished=false;returning=false;cameraYaw=0;turnStarted=0;};

function overview() {
  selectedPoint = null;
  selectedTarget = null;
  refreshRouteControls();
  $('sectorPanel').classList.remove('revealed');
  $('atlasFocusLabel').textContent = 'SELECT A WAYPOINT';
  $('waypointSelect').value = '';
}

$('atlasOverview').onclick = () => {
  overview();
  marsMap?.overview();
};
$('collapseSector').onclick = overview;
$('atlasZoomIn').onclick = () => marsMap?.zoomIn();
$('atlasZoomOut').onclick = () => marsMap?.zoomOut();

function tripEnd(){return (routes[chosen].time+(detour?8:0))*40}
const api = createApiClient();
let backendRegion = null;
let backendConfig = null;
let marsMap = null;
let mapMounting = false;
overview();

function refreshRouteControls() {
  const canCheck = Boolean(selectedTarget && backendRegion?.status === 'demo' && backendConfig);
  $('brief').disabled = !canCheck;
  $('requestRoute').disabled = !canCheck || routeCheckPending;
  $('requestReturn').disabled = !canCheck || routeCheckPending;
}

async function loadTargets() {
  const response = await fetch('/map-data/targets.geojson');
  if (!response.ok) throw new Error('Science target catalog unavailable.');
  const catalog = await response.json();
  if (catalog.type !== 'FeatureCollection' || !Array.isArray(catalog.features)) {
    throw new Error('Invalid science target catalog.');
  }
  return new Map(catalog.features.map(({geometry, properties}) => {
    const [lon, lat] = geometry.coordinates;
    return [properties.id, {...properties, point: {lat, lon}}];
  }));
}

async function loadBackend() {
  $('apiStatus').textContent = 'Loading mission configuration…';
  backendConfig = null;
  refreshRouteControls();
  try {
    const [config, region] = await Promise.all([api.getConfig(), api.getRegion()]);
    backendConfig = config.config;
    backendRegion = region;
    $('apiStatus').textContent = `${region.name} · Data ${region.dataVersion}`;
    try {
      listedTargets = await loadTargets();
      targetCatalogAvailable = true;
      const selectedId = $('waypointSelect').value;
      if (selectedPoint) {
        selectedTarget = listedTargets.get(selectedId) ?? null;
        showTargetStatus();
      }
    } catch {
      listedTargets.clear();
      selectedTarget = null;
      targetCatalogAvailable = false;
      if (selectedPoint) showTargetStatus();
    }
    await prepareRealMap();
  } catch (error) {
    backendRegion = null;
    $('apiStatus').textContent = `Backend unavailable: ${error.message}`;
    if (!marsMap) $('mapLoading').textContent = 'Jezero map unavailable. ' + error.message;
  } finally {
    refreshRouteControls();
  }
}

function showRouteDirection(returningToBase) {
  const destination = returningToBase ? backendRegion.base : selectedTarget.point;
  $('apiLat').value = String(destination.lat);
  $('apiLon').value = String(destination.lon);
  const direction = returningToBase
    ? `${selectedTarget.name} → ${backendRegion.base.label}`
    : `${backendRegion.base.label} → ${selectedTarget.name}`;
  $('routeDirection').textContent = direction + ' · Starting mission budget';
}

const rolePrefixes = ['Recommended', 'Fastest', 'Science-focused'];
const detourPrefix = 'Optional science detour:';

function renderCandidate(candidate) {
  const card = document.createElement('article');
  card.className = 'route route-result';
  const title = document.createElement('strong');
  title.textContent = candidate.id;
  card.append(title);

  const reasons = candidate.reasons;
  const roles = rolePrefixes.filter(role => reasons.some(reason => reason.startsWith(role + ':')));
  const detour = reasons.find(reason => reason.startsWith(detourPrefix));
  const detourId = /\+detour-(.+)$/.exec(candidate.id)?.[1];
  const badges = document.createElement('div');
  badges.className = 'route-result-badges';
  for (const label of [...roles, ...(detour || detourId ? ['Optional science detour'] : [])]) {
    const badge = document.createElement('span');
    badge.textContent = label;
    badges.append(badge);
  }
  if (badges.childElementCount) card.append(badges);

  if (detourId) {
    const target = document.createElement('p');
    target.textContent = 'Detour stop: ' + (listedTargets.get(detourId)?.name ?? detourId);
    card.append(target);
  }
  const metrics = document.createElement('p');
  metrics.textContent = `${candidate.feasibility} · Score ${candidate.overallScore ?? 'unavailable'} · Drive ${candidate.driveMinutes ?? 'unavailable'} min`;
  card.append(metrics);

  if (reasons.length) {
    const explanation = document.createElement('ul');
    for (const reason of reasons) {
      const item = document.createElement('li');
      item.textContent = reason;
      explanation.append(item);
    }
    card.append(explanation);
  }
  return card;
}

async function checkRoute(returningToBase) {
  if (!selectedTarget || !backendConfig || backendRegion?.status !== 'demo' || routeCheckPending) return;
  const {point} = selectedTarget;
  const {base, id: regionId, dataVersion} = backendRegion;
  const {missionDurationMinutes, batteryCapacityKWh, startChargePercent} = backendConfig;
  routeCheckPending = true;
  refreshRouteControls();
  showRouteDirection(returningToBase);
  $('apiResults').textContent = returningToBase ? 'Checking return to base…' : 'Evaluating outbound routes…';
  try {
    const result = await api.planRoutes({
      requestId: crypto.randomUUID(),
      regionId,
      dataVersion,
      origin: returningToBase ? point : base,
      base,
      destination: returningToBase ? base : point,
      stopIds: [],
      remainingMinutes: missionDurationMinutes,
      currentBatteryKWh: batteryCapacityKWh * startChargePercent / 100
    });
    if (!result || selectedTarget?.point !== point) return;
    $('apiResults').replaceChildren();
    for (const candidate of result.candidates) $('apiResults').append(renderCandidate(candidate));
    for (const message of result.errors) {
      const notice = document.createElement('p');
      notice.textContent = message;
      $('apiResults').append(notice);
    }
    if (!$('apiResults').childElementCount) $('apiResults').textContent = 'No matching routes were returned.';
  } catch (error) {
    if (selectedTarget?.point === point) $('apiResults').textContent = error.message;
  } finally {
    routeCheckPending = false;
    refreshRouteControls();
  }
}

$('retryApi').onclick = loadBackend;
$('requestRoute').onclick = () => checkRoute(false);
$('requestReturn').onclick = () => checkRoute(true);
loadBackend();

async function prepareRealMap() {
  if (marsMap || mapMounting) return;
  mapMounting = true;
  try {
    marsMap = await mountMarsMap({
      container: $('mars-map'),
      region: backendRegion,
      onSelect: selectGeographicPoint,
      onStatus: message => $('mapDataLabel').textContent = message
    });
    $('mars-map').hidden = false;
    $('mapLoading').hidden = true;
    $('mapDataLabel').hidden = false;
    $('waypointDirectory').hidden = marsMap.waypoints.length === 0;
    renderWaypointOptions();
    if (scene === 'setup') requestAnimationFrame(() => marsMap.overview());
  } catch (error) {
    $('mapLoading').textContent = 'Jezero map unavailable. ' + error.message;
  } finally {
    mapMounting = false;
  }
}

function formatPoint({lat, lon}) {
  return `${Math.abs(lat).toFixed(6)}° ${lat < 0 ? 'S' : 'N'}, ${Math.abs(lon).toFixed(6)}° ${lon < 0 ? 'W' : 'E'}`;
}

function renderWaypointOptions() {
  const search = $('waypointSearch').value.trim().toLowerCase();
  const options = [new Option('Choose a waypoint', '')];
  for (const {properties} of marsMap.waypoints) {
    const {RMC, sol} = properties;
    const label = `Sol ${sol} · ${RMC}`;
    if (!search || label.toLowerCase().includes(search)) {
      options.push(new Option(label, RMC));
    }
  }
  if (options.length === 1 && search) options[0].textContent = 'No matching waypoints';
  $('waypointSelect').replaceChildren(...options);
}

$('waypointSearch').oninput = renderWaypointOptions;
$('waypointSelect').onchange = event => marsMap.selectWaypoint(event.target.value);

function formatMeasurement(value, unit, scale = 1, fractionDigits = 1) {
  if (!Number.isFinite(value) || value === -9999) return 'Unavailable';
  return (value / scale).toLocaleString('en', {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits
  }) + ' ' + unit;
}

const waypointPhotos = {
  '49_370': {
    image: '/assets/waypoints/49_370.jpg',
    source: 'https://mars.nasa.gov/mars2020/multimedia/raw-images/NRF_1021_0757580999_659ECM_N0490370NCAM03021_12_095J',
    label: 'Right Navcam · Sol 1021 · NASA/JPL-Caltech'
  }
};

function renderWaypointRecord(properties) {
  const photo = waypointPhotos[properties.RMC];
  $('waypointPhoto').hidden = !photo;
  if (photo) {
    $('waypointPhotoImage').src = photo.image;
    $('waypointPhotoImage').alt = `Perseverance Right Navcam image at site ${properties.site}, drive ${properties.drive}`;
    $('waypointPhotoSource').href = photo.source;
    $('waypointPhotoSource').textContent = photo.label;
  }
  $('waypointRecord').hidden = false;

  const facts = [
    ['Site', properties.site],
    ['Drive', properties.drive],
    ['Elevation (Mars geoid)', formatMeasurement(properties.elev_geoid, 'm')],
    ['Distance from previous record', formatMeasurement(properties.dist_m, 'm')],
    ['Total rover distance', formatMeasurement(properties.dist_total_m, 'km', 1000, 2)]
  ];
  $('waypointFacts').replaceChildren();
  for (const [label, value] of facts) {
    const row = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.textContent = label;
    description.textContent = value ?? 'Unavailable';
    row.append(term, description);
    $('waypointFacts').append(row);
  }

  $('waypointNote').textContent = properties.Note || 'NASA supplied no localization note.';
  const panorama = properties.images?.find(image => image.isPanoramic && image.url);
  $('waypointPanorama').hidden = !panorama;
  $('waypointPanorama').open = false;
  $('panoramaReference').textContent = panorama
    ? panorama.url.split('/').at(-1)
    : '';
}

function showTargetStatus() {
  $('waypointRouteStatus').textContent = selectedTarget
    ? `${selectedTarget.name} · ${selectedTarget.stopMinutes} min science stop`
    : targetCatalogAvailable
      ? 'Route checks are available for listed science targets.'
      : 'Science target catalog unavailable.';
  refreshRouteControls();
}

function selectGeographicPoint(point, properties) {
  if (!properties?.RMC) return;
  selectedPoint = point;
  selectedTarget = listedTargets.get(properties.RMC) ?? null;
  showTargetStatus();
  $('apiResults').replaceChildren();
  $('sectorPanel').classList.add('revealed');
  $('sectorPanel').scrollTop = 0;
  $('sectorType').textContent = 'PERSEVERANCE WAYPOINT';
  $('sectorTitle').textContent = `Sol ${properties.sol} · ${properties.RMC}`;
  $('sectorDescription').textContent = formatPoint(point);
  renderWaypointRecord(properties);
  const gallery = $('waypointImageGallery');
  gallery.href = `https://mars.nasa.gov/mars2020/multimedia/raw-images/?begin_sol=${properties.sol}&end_sol=${properties.sol}`;
  gallery.textContent = `Browse NASA photos from Sol ${properties.sol} ↗`;
  $('waypointSelect').value = properties.RMC;
  $('atlasFocusLabel').textContent = formatPoint(point);
}
addEventListener('resize',()=>marsMap?.resize());addEventListener('pagehide',()=>marsMap?.destroy());
