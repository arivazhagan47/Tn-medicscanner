let map;
let userLat = null;
let userLng = null;
let markers = [];
let lastScanTime = 0;
let scanCache = {};
const SCAN_COOLDOWN = 20000; // 20s cooldown
const MAX_RESULTS = 75;

/* =========================
   BOOT MAP
========================= */
function boot() {
  map = L.map("map").setView([11.1271, 78.6569], 7);
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
    { attribution: "© OpenStreetMap © CARTO" }
  ).addTo(map);

  setInfo("SYSTEM ONLINE – TAMIL NADU");
}
function filterList() {
  const input = document.getElementById("listSearch").value.toLowerCase();
  const items = document.querySelectorAll("#resultList li");

  items.forEach(li => {
    const text = li.innerText.toLowerCase();
    li.style.display = text.includes(input) ? "block" : "none";
  });
}

/* =========================
   GPS LOCK
========================= */
function lockGPS() {
  if (!navigator.geolocation) { setInfo("GPS NOT SUPPORTED"); return; }

  navigator.geolocation.getCurrentPosition(pos => {
    userLat = pos.coords.latitude;
    userLng = pos.coords.longitude;

    clearAll();
    map.setView([userLat, userLng], 15);
    addUserMarker("YOU (GPS)");
    setInfo("GPS LOCKED");
    updateRadarPosition();
    map.on("move zoom", updateRadarPosition);
  }, () => setInfo("GPS PERMISSION DENIED"));
}

/* =========================
   LOCATION SEARCH
========================= */
function searchLocation() {
  const q = document.getElementById("locationInput").value.trim();
  if (!q) return;

  setInfo("LOCATING " + q + "...");
  fetch(`https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(q + ", Tamil Nadu")}`)
    .then(r => r.json())
    .then(d => {
      if (!d.length) { setInfo("LOCATION NOT FOUND"); return; }
      userLat = +d[0].lat;
      userLng = +d[0].lon;

      clearAll();
      map.setView([userLat, userLng], 14);
      addUserMarker(q);
      setInfo("LOCATION SET: " + q);
      updateRadarPosition();
      map.on("move zoom", updateRadarPosition);
    }).catch(() => setInfo("LOCATION SEARCH FAILED"));
}

/* =========================
   ADD USER MARKER
========================= */
function addUserMarker(label) {
  const m = L.circle([userLat, userLng], {
    radius: 120,
    color: "#00ff99",
    fillColor: "#00ff99",
    fillOpacity: 0.9
  }).addTo(map).bindPopup("📍 " + label);

  markers.push(m);
}

/* =========================
   SCAN NEARBY (10KM) WITH CACHE + PRIORITY
========================= */
function scanNearby() {
  if (!userLat || !userLng) { setInfo("SET LOCATION OR GPS FIRST"); return; }
  const now = Date.now();
  if (now - lastScanTime < SCAN_COOLDOWN) { setInfo("WAIT 20s BEFORE NEXT SCAN"); return; }
  lastScanTime = now;

  clearAll();
  document.getElementById("resultList").innerHTML = "";
  setInfo("SCANNING 10 KM RADIUS...");

  const cacheKey = `${userLat.toFixed(3)},${userLng.toFixed(3)}`;
  if (scanCache[cacheKey]) { renderResults(scanCache[cacheKey]); setInfo("LOADING FROM CACHE"); return; }

  const query = `[out:json][timeout:25];
    (
      node["amenity"="hospital"](around:10000,${userLat},${userLng});
      node["amenity"="clinic"](around:10000,${userLat},${userLng});
      node["amenity"="pharmacy"](around:10000,${userLat},${userLng});
    ); out tags center;`;

  const servers = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.nchc.org.tw/api/interpreter"
  ];
  tryOverpass(servers, query, 0, cacheKey);
}

/* =========================
   OVERPASS FETCH WITH FALLBACK
========================= */
function tryOverpass(servers, query, index, cacheKey) {
  if (index >= servers.length) { setInfo("ALL SERVERS BUSY – TRY LATER"); return; }

  fetch(servers[index] + "?data=" + encodeURIComponent(query))
    .then(res => { if(!res.ok) throw new Error(); return res.json(); })
    .then(data => {
      if (!data.elements || data.elements.length===0) { setInfo("NO FACILITIES FOUND"); return; }

      const processed = data.elements.map(p => {
        p.distance = getDistanceKm(userLat, userLng, p.lat, p.lon);
        p.priority = calculatePriority(p); // Level 3 scoring
        return p;
      })
      .sort((a,b) => a.priority - b.priority) // best priority first
      .slice(0, MAX_RESULTS);

      scanCache[cacheKey] = processed;
      renderResults(processed);
    })
    .catch(() => tryOverpass(servers, query, index+1, cacheKey));
}

/* =========================
   CALCULATE PRIORITY (LEVEL 3)
========================= */
function calculatePriority(p) {
  let score = p.distance; // closer = better
  if(p.tags.amenity==="hospital") score -= 2; // hospitals preferred
  if(p.tags.phone || p.tags["contact:phone"]) score -= 1; // has contact
  return score;
}

/* =========================
   RENDER RESULTS + FILTER + HIGHLIGHT
========================= */
function renderResults(list) {
  clearAll();
  const resultList = document.getElementById("resultList");

  // Find nearest hospital for auto zoom & highlight
  const nearestHospital = list.find(p => p.tags.amenity==="hospital");
  if(nearestHospital) map.setView([nearestHospital.lat, nearestHospital.lon],17);

  list.forEach((p,i) => {
    const li = document.createElement("li");
    li.dataset.type = p.tags.amenity;
    const distanceText = p.distance.toFixed(2) + " km";
    const nameTamil = p.tags["name:ta"] || "";
    const phone = p.tags.phone || p.tags["contact:phone"] || "N/A";

    li.innerHTML = `<b>${p.tags.name || "Unnamed"}</b> ${nameTamil}<br>
                    ${p.tags.amenity.toUpperCase()}<br>
                    📏 ${distanceText} | ☎ ${phone} <br>
                    ${phone!=="N/A"?`<a href="tel:${phone}">📲 CALL</a>`:""}`;

    // highlight nearest
    if(i===0) li.classList.add("nearest");

    li.onclick = () => {
        map.setView([p.lat, p.lon], 18);
        marker.openPopup();
        showDetails(p);
      };
      
    resultList.appendChild(li);

    // Add marker
    const color = p.tags.amenity==="hospital"?"#ff3333":p.tags.amenity==="clinic"?"#ffff00":"#00ccff";
    const marker = L.circle([p.lat,p.lon],{radius:90,color,fillColor:color,fillOpacity:0.7}).addTo(map);
    markers.push(marker);
  });
  setInfo(`SCAN COMPLETE – SHOWING ${list.length}`);
}

/* =========================
   FILTER RESULTS (LEVEL1)
========================= */
function filterResults(type){
  document.querySelectorAll("#resultList li").forEach(li=>{
    li.style.display = (type==="all"||li.dataset.type===type)?"block":"none";
  });
}

/* =========================
   EMERGENCY MODE BUTTON (LEVEL2)
========================= */
function emergencyMode(){
  if(!userLat||!userLng){ setInfo("SET LOCATION FIRST"); return; }

  // find nearest hospital
  let nearest = markers[0];
  if(!nearest){ setInfo("NO HOSPITALS FOUND"); return; }

  // scroll list to nearest hospital
  const firstLi = document.querySelector("#resultList li");
  if(firstLi) firstLi.scrollIntoView({behavior:"smooth"});

  map.setView([userLat,userLng],16);
  setInfo("EMERGENCY MODE ACTIVATED! 📍 Nearest hospital highlighted.");
}

/* =========================
   CLEAR MAP
========================= */
function clearAll(){
  markers.forEach(m=>map.removeLayer(m));
  markers=[];
}

/* =========================
   INFO HUD
========================= */
function setInfo(text){ document.getElementById("info").innerText=text; }

/* =========================
   RADAR POSITION
========================= */
function updateRadarPosition(){
  const radar = document.getElementById("radar");
  if(!radar||!map||!userLat||!userLng) return;
  const point = map.latLngToContainerPoint([userLat,userLng]);
  radar.style.left = point.x - 120 + "px";
  radar.style.top = point.y - 120 + "px";
}

/* =========================
   DISTANCE CALCULATION
========================= */
function getDistanceKm(lat1,lon1,lat2,lon2){
  const R=6371;
  const dLat=(lat2-lat1)*Math.PI/180;
  const dLon=(lon2-lon1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}
function showDetails(p) {
    const panel = document.getElementById("detailsPanel");
    const box = document.getElementById("detailsContent");
  
    const name = p.tags.name || "Unnamed Facility";
    const type = p.tags.amenity;
    const distance = p.distance ? p.distance.toFixed(2) + " km" : "N/A";
    const phone =
      p.tags.phone ||
      p.tags["contact:phone"] ||
      p.tags.mobile ||
      "Not Available";
  
    const address = [
      p.tags["addr:housenumber"],
      p.tags["addr:street"],
      p.tags["addr:suburb"],
      p.tags["addr:city"],
      p.tags["addr:district"],
      p.tags["addr:state"]
    ].filter(Boolean).join(", ");
  
    const emergency =
      p.tags.emergency === "yes" ||
      p.tags["healthcare:speciality"] === "emergency"
        ? "YES"
        : "UNKNOWN";
  
    box.innerHTML = `
      <h2>${name}</h2>
      <p><b>Type:</b> ${type.toUpperCase()}</p>
      <p><b>Distance:</b> ${distance}</p>
      <p><b>Emergency:</b> ${emergency}</p>
      <p><b>Address:</b> ${address || "Not Available"}</p>
      <p><b>Phone:</b> ${phone}</p>
  
      ${phone !== "Not Available"
        ? `<p><a href="tel:${phone}">📞 CALL NOW</a></p>`
        : ""}
  
      <p>
        <a target="_blank"
           href="https://www.google.com/maps/dir/?api=1&destination=${p.lat},${p.lon}">
           🧭 GET DIRECTIONS
        </a>
      </p>
    `;
  
    panel.classList.remove("hidden");
  }
  function closeDetails() {
    document.getElementById("detailsPanel").classList.add("hidden");
  }
    // Configuration
const radarRadius = 100; // Half of the 200px container
const maxDetectionRange = 5000; // Meters to show on radar

function updateRadar(map, markers) {
    const overlay = document.getElementById('blip-overlay');
    const posDisplay = document.getElementById('radar-pos');
    const center = map.getCenter();
    
    // Update coordinate display
    posDisplay.innerText = `${center.lat.toFixed(2)}, ${center.lng.toFixed(2)}`;
    
    // Clear old blips
    overlay.innerHTML = '';

    markers.forEach(marker => {
        const targetLatLng = marker.getLatLng();
        
        // Calculate distance (meters) and bearing (degrees)
        const distance = center.distanceTo(targetLatLng);
        
        if (distance < maxDetectionRange) {
            // Normalize distance to radar pixels
            const distPx = (distance / maxDetectionRange) * radarRadius;
            
            // Calculate angle between center and marker
            const angle = Math.atan2(
                targetLatLng.lng - center.lng,
                targetLatLng.lat - center.lat
            );

            // Convert Polar to Cartesian (X, Y)
            const x = radarRadius + distPx * Math.sin(angle);
            const y = radarRadius - distPx * Math.cos(angle);

            // Create the blip element
            const blip = document.createElement('div');
            blip.className = 'blip';
            blip.style.left = `${x}px`;
            blip.style.top = `${y}px`;
            
            // Sync animation with the radar sweep
            // (Optional: calculates when sweep will hit the blip)
            blip.style.animationDelay = `${(angle / (Math.PI * 2)) * 4}s`;
            
            overlay.appendChild(blip);
        }
    });
}

// Hook into Leaflet's move event
map.on('move', () => updateRadar(map, allMarkers));