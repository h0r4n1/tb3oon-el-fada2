
// NEBULA - Mars Mission Planner
// Initial map setup and coordinate selection

const JEZERO_CENTER = [18.4, 77.5]; // Approximate Jezero region center

// Use geographic coordinates: [latitude, longitude].
// We are not adding a basemap until the Mars imagery source is verified.
const map = L.map("map", {
  crs: L.CRS.EPSG4326,
  minZoom: 2,
  maxZoom: 8
}).setView(JEZERO_CENTER, 4);

// Elements in the sidebar
const latitudeDisplay = document.getElementById("latitude");
const longitudeDisplay = document.getElementById("longitude");
const selectionStatus = document.getElementById("selection-status");
const clearButton = document.getElementById("clear-selection");

// Store the currently selected marker
let selectedMarker = null;

// Format coordinates to 5 decimal places
function formatCoordinate(value) {
  return value.toFixed(5) + "°";
}

// Handle clicks on the map
map.on("click", function (event) {
  const latitude = event.latlng.lat;
  const longitude = event.latlng.lng;

  // Remove the previous marker
  if (selectedMarker) {
    map.removeLayer(selectedMarker);
  }

  // Add a marker at the newly selected location
  selectedMarker = L.circleMarker([latitude, longitude], {
    radius: 7,
    color: "#f0b45e",
    weight: 2,
    fillColor: "#f0b45e",
    fillOpacity: 0.9
  }).addTo(map);

  // Update the coordinate display
  latitudeDisplay.textContent = formatCoordinate(latitude);
  longitudeDisplay.textContent = formatCoordinate(longitude);
  selectionStatus.textContent = "Location selected.";
});

// Clear the selected location
clearButton.addEventListener("click", function () {
  if (selectedMarker) {
    map.removeLayer(selectedMarker);
    selectedMarker = null;
  }

  latitudeDisplay.textContent = "—";
  longitudeDisplay.textContent = "—";
  selectionStatus.textContent = "No location selected.";
});

// Imagery and coverage controls are placeholders for now.
// They will be connected when their data sources are added.
document.getElementById("layer-imagery").disabled = true;
document.getElementById("layer-coverage").disabled = true;
